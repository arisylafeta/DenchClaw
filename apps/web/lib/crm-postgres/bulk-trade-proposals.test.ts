import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../gmail-drafts", () => ({ fetchGmailAttachment: vi.fn(async () => Buffer.from("pdf-bytes")) }));
const startHistoryPass = vi.hoisted(() => vi.fn(() => true));
vi.mock("../history-pass", () => ({ startHistoryPass }));

// Runs only against a disposable database: scripts/rebattery/crm-test-db.sh up prints the URL.
const TEST_URL = process.env.BULK_TRADES_TEST_DATABASE_URL;

describe.skipIf(!TEST_URL)("inbox check proposals", () => {
  let pg: typeof import("../postgres");
  let trades: typeof import("./bulk-trades");
  let details: typeof import("./bulk-trade-details");
  let proposals: typeof import("./bulk-trade-proposals");
  let user: { id: string; email: string };
  let lotId: string;
  let buyerId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_URL;
    pg = await import("../postgres");
    trades = await import("./bulk-trades");
    details = await import("./bulk-trade-details");
    proposals = await import("./bulk-trade-proposals");
    const [row] = await pg.queryPg<{ id: string; email: string }>(
      `insert into crm_users (email, display_name, password_hash)
       values ('proposals-' || gen_random_uuid() || '@example.test', 'Alex', 'x') returning id, email`,
    );
    user = row;
    lotId = (await trades.createBulkTrade({ title: "Proposal trade", trade_kind: "packs", trade_stage: "With buyers" }, user.id)).id;
    buyerId = (await details.addBuyer(lotId, { name: "Synthetic Buyer" }, user.id))!.id;
  });

  afterAll(async () => {
    await pg.pgPool.end();
  });

  async function propose(kind: string, target: string | null, proposed: object, lot: string | null = lotId) {
    const [row] = await pg.queryPg<{ id: string }>(
      `insert into crm_bulk_trade_proposals (lot_id, kind, target, proposed, summary, quote, source_kind, source_id, source_label, source_at)
       values ($1, $2, $3, $4, 'Summary', 'A quoted line', 'gmail', gen_random_uuid()::text, 'Gmail · sam@supplier.test', '2026-09-29')
       returning id::text as id`,
      [lot, kind, target, JSON.stringify(proposed)],
    );
    return row.id;
  }

  it("applies each kind through the normal write path and logs it", async () => {
    await proposals.decideProposal(await propose("field", "manufacture_date", { value: "2021 to 2025", status: "unverified" }), "accept", user);
    await proposals.decideProposal(await propose("buyer_update", buyerId, { status: "Teaser sent", last_touch_via: "Email" }), "accept", user);
    await proposals.decideProposal(await propose("next_step", null, { next_step: "Ask for the address", next_step_due: "2026-10-01" }), "accept", user);
    await proposals.decideProposal(await propose("new_buyer", null, { name: "New Buyer Co", wants: "36 packs" }), "accept", user);
    await proposals.decideProposal(await propose("file", null, { file_name: "spec.pdf", gmail_message_id: "g1", file_type: "Datasheet" }), "accept", user);
    await proposals.decideProposal(await propose("link_contact", null, { name: "sam@supplier.test", email: "sam@supplier.test" }), "accept", user);

    const detail = (await details.getTradeDetail(lotId))!;
    expect(detail.fields.find((field) => field.field_key === "manufacture_date")).toMatchObject({
      value: "2021 to 2025", source_label: "Gmail · sam@supplier.test", source_date: "2026-09-29",
    });
    expect(detail.buyers.map((buyer) => [buyer.name, buyer.status])).toEqual([["Synthetic Buyer", "Teaser sent"], ["New Buyer Co", "To contact"]]);
    expect(detail.trade).toMatchObject({ next_step: "Ask for the address", next_step_due: "2026-10-01" });
    expect(detail.files).toMatchObject([{ file_name: "spec.pdf", file_type: "Datasheet", visibility: "never" }]);
    expect(detail.contacts).toMatchObject([{ email: "sam@supplier.test" }]);
    expect(await proposals.tradeProposals(lotId)).toEqual([]);
    const events = await pg.queryPg<{ kind: string }>("select kind from crm_bulk_trade_events where lot_id = $1", [lotId]);
    expect(events.filter((event) => event.kind === "proposal_accepted")).toHaveLength(6);
  });

  it("applies a proposal once however often it is clicked, and ignores without changing anything", async () => {
    const id = await propose("next_step", null, { next_step: "Clicked twice" });
    const [first, second] = await Promise.all([
      proposals.decideProposal(id, "accept", user), proposals.decideProposal(id, "accept", user),
    ]);
    expect([first.ok, second.ok].sort()).toEqual([false, true]);

    const ignored = await propose("field", "location", { value: "Turin" });
    await proposals.decideProposal(ignored, "ignore", user);
    expect((await details.getTradeDetail(lotId))!.fields.find((field) => field.field_key === "location")).toBeUndefined();
  });

  it("puts a proposal back to new when it can no longer apply", async () => {
    const id = await propose("buyer_update", "btb_gone", { status: "Won" });
    const result = await proposals.decideProposal(id, "accept", user);
    expect(result).toMatchObject({ ok: false, status: 422 });
    expect((await proposals.tradeProposals(lotId)).map((proposal) => proposal.id)).toContain(id);
  });

  it("creates a trade from a possible new trade and reports its id", async () => {
    const id = await propose("possible_trade", null, { title: "Leaf packs, Leeds", trade_kind: "packs" }, null);
    const result = await proposals.decideProposal(id, "accept", user);
    expect(result.ok && result.lot_id).toBeTruthy();
    const created = await trades.getBulkTrade((result as { lot_id: string }).lot_id);
    expect(created).toMatchObject({ title: "Leaf packs, Leeds", trade_kind: "packs", next_step: "Qualify this lead" });
  });

  it("reads a new contact's history, and fills a trade created from a possible new trade", async () => {
    startHistoryPass.mockClear();
    await proposals.decideProposal(await propose("link_contact", null, { name: "Nic", email: "nic@oem.test" }), "accept", user);
    expect(startHistoryPass).toHaveBeenCalledWith(lotId);

    const id = await propose("possible_trade", null, { title: "Kona packs, Wales", trade_kind: "packs", email: "seller@kona.test" }, null);
    const result = await proposals.decideProposal(id, "accept", user) as { ok: true; lot_id: string };
    const created = (await details.getTradeDetail(result.lot_id))!;
    expect(created.contacts).toMatchObject([{ email: "seller@kona.test" }]);
    expect(startHistoryPass).toHaveBeenLastCalledWith(result.lot_id);

    const kindless = (await trades.createBulkTrade({ title: "Kindless" }, user.id)).id;
    await proposals.decideProposal(await propose("trade_kind", null, { trade_kind: "cells" }, kindless), "accept", user);
    expect(await trades.getBulkTrade(kindless)).toMatchObject({ trade_kind: "cells" });
  });

  it("does not start a second history pass while one is running", async () => {
    startHistoryPass.mockClear();
    await pg.queryPg("insert into crm_bulk_trade_check_runs (kind, lot_id, status) values ('history', $1, 'running')", [lotId]);
    expect(await proposals.requestHistoryPass(lotId)).toBe(false);
    expect(startHistoryPass).not.toHaveBeenCalled();
    expect(await proposals.historyStatus(lotId)).toMatchObject({ status: "running" });
  });

  describe("undoing what the inbox check applied", () => {
    let undoLot: string;
    let runId: string;

    beforeAll(async () => {
      undoLot = (await trades.createBulkTrade({ title: "Undo trade", trade_kind: "packs", next_step: "Alex's step" }, user.id)).id;
      [{ id: runId }] = await pg.queryPg<{ id: string }>("insert into crm_bulk_trade_check_runs (kind, lot_id) values ('history', $1) returning id::text as id", [undoLot]);
    });

    async function applied(kind: string, target: string | null, proposed: object, undo: object) {
      const [row] = await pg.queryPg<{ id: string }>(
        `insert into crm_bulk_trade_proposals (lot_id, run_id, kind, target, proposed, summary, quote, source_kind, source_id,
           source_label, source_at, status, applied_at, undo)
         values ($1, $2, $3, $4, $5, $3 || ' change', 'A quoted line', 'gmail', gen_random_uuid()::text, 'Gmail · nic@oem.test',
           '2026-09-24', 'applied', now(), $6) returning id::text as id`,
        [undoLot, runId, kind, target, JSON.stringify(proposed), JSON.stringify(undo)],
      );
      return row.id;
    }

    const field = async (key: string) => (await details.getTradeDetail(undoLot))!.fields.find((f) => f.field_key === key);

    it("lists applied changes and removes a detail the check added", async () => {
      await pg.queryPg("insert into crm_bulk_trade_fields (lot_id, field_key, value, status) values ($1, 'quantity', '600 packs', 'unverified')", [undoLot]);
      const id = await applied("field", "quantity", { value: "600 packs", status: "unverified" }, { before: null, value: "600 packs" });
      expect((await proposals.appliedChanges(undoLot)).map((change) => [change.id, change.conflict])).toContainEqual([id, false]);

      expect(await proposals.undoChange(id, user.id)).toEqual({ ok: true, lot_id: undoLot });
      expect(await field("quantity")).toBeUndefined();
      expect((await proposals.appliedChanges(undoLot)).map((change) => change.id)).not.toContain(id);
      expect(await proposals.undoChange(id, user.id)).toMatchObject({ ok: false, status: 404 });
      const [event] = await pg.queryPg<{ kind: string; actor_user_id: string }>(
        "select kind, actor_user_id from crm_bulk_trade_events where lot_id = $1 order by id desc limit 1", [undoLot]);
      expect(event).toEqual({ kind: "auto_undone", actor_user_id: user.id });
    });

    it("refuses to undo a detail changed since, and restores the old value otherwise", async () => {
      await pg.queryPg(
        `insert into crm_bulk_trade_fields (lot_id, field_key, value, status, source_label) values ($1, 'location', 'Turin', 'unverified', 'Gmail · new')`,
        [undoLot]);
      const id = await applied("field", "location", { value: "Turin", status: "unverified" },
        { before: { value: "Italy", status: "unverified", source_label: "Gmail · old", source_url: null, source_date: "2026-05-01" }, value: "Turin" });
      await details.setField(undoLot, "location", { value: "Milan" }, user.id);
      expect(await proposals.undoChange(id, user.id)).toMatchObject({ ok: false, status: 409 });

      await details.setField(undoLot, "location", { value: "Turin" }, user.id);
      expect(await proposals.undoChange(id, user.id)).toMatchObject({ ok: true });
      expect(await field("location")).toMatchObject({ value: "Italy", source_label: "Gmail · old", source_date: "2026-05-01" });
    });

    it("takes a conflicting claim back off Alex's value", async () => {
      await pg.queryPg(
        `insert into crm_bulk_trade_fields (lot_id, field_key, value, status, alternatives)
         values ($1, 'chemistry', 'NMC', 'conflict', '[{"value": "LFP", "source_label": "Gmail · nic@oem.test"}]')`, [undoLot]);
      const id = await applied("field", "chemistry", { value: "LFP", status: "unverified" },
        { before: { value: "NMC", status: "confirmed", alternatives: [] }, conflict: true });
      expect((await proposals.appliedChanges(undoLot)).find((change) => change.id === id)?.conflict).toBe(true);
      await proposals.undoChange(id, user.id);
      expect(await field("chemistry")).toMatchObject({ value: "NMC", status: "confirmed", alternatives: [] });
    });

    it("undoes a whole run, reporting what changed since", async () => {
      const contact = (await details.addContact(undoLot, { name: "Matteo", email: "matteo@oem.test" }, user.id))!;
      await applied("link_contact", null, { name: "Matteo", email: "matteo@oem.test" }, { id: contact.id });
      await pg.queryPg("update crm_bulk_trade_lots set next_step = 'Ask Nicola for pack photos', next_step_due = '2026-10-01' where id = $1", [undoLot]);
      await applied("next_step", null, { next_step: "Ask Nicola for pack photos" }, {
        before: { next_step: "Alex's step", next_step_due: null, waiting_on: "us", waiting_since: null, next_step_contact_id: null, next_step_buyer_id: null },
        after: { next_step: "Ask Nicola for pack photos" },
      });
      await pg.queryPg("insert into crm_bulk_trade_fields (lot_id, field_key, value) values ($1, 'capacity', '23.8 kWh')", [undoLot]);
      await applied("field", "capacity", { value: "23.8 kWh" }, { before: null, value: "23.8 kWh" });
      await details.setField(undoLot, "capacity", { value: "24 kWh" }, user.id);

      const result = await proposals.undoRun(undoLot, runId, user.id);
      expect(result.undone).toBe(2);
      expect(result.refused).toMatchObject([{ summary: "field change" }]);
      const detail = (await details.getTradeDetail(undoLot))!;
      expect(detail.contacts).toEqual([]);
      expect(detail.trade).toMatchObject({ next_step: "Alex's step", next_step_due: null });
      expect(detail.fields.find((f) => f.field_key === "capacity")?.value).toBe("24 kWh");
    });
  });
});
