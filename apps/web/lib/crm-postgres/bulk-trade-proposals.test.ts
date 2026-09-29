import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../gmail-drafts", () => ({ fetchGmailAttachment: vi.fn(async () => Buffer.from("pdf-bytes")) }));

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

    const detail = (await details.getTradeDetail(lotId))!;
    expect(detail.fields.find((field) => field.field_key === "manufacture_date")).toMatchObject({
      value: "2021 to 2025", source_label: "Gmail · sam@supplier.test", source_date: "2026-09-29",
    });
    expect(detail.buyers.map((buyer) => [buyer.name, buyer.status])).toEqual([["Synthetic Buyer", "Teaser sent"], ["New Buyer Co", "To contact"]]);
    expect(detail.trade).toMatchObject({ next_step: "Ask for the address", next_step_due: "2026-10-01" });
    expect(detail.files).toMatchObject([{ file_name: "spec.pdf", file_type: "Datasheet", visibility: "never" }]);
    expect(await proposals.tradeProposals(lotId)).toEqual([]);
    const events = await pg.queryPg<{ kind: string }>("select kind from crm_bulk_trade_events where lot_id = $1", [lotId]);
    expect(events.filter((event) => event.kind === "proposal_accepted")).toHaveLength(5);
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
});
