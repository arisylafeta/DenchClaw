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
    buyerId = `btb_${crypto.randomUUID()}`;
    await pg.queryPg(`insert into crm_bulk_offers (id, bulk_listing_id, role, name, stage) values ($1, $2, 'counterparty', 'Synthetic Buyer', 'candidate')`,
      [buyerId, lotId]);
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

    // Lots are frozen: accepted proposals land on the Trades Preview listing with the same id.
    const [fact] = await pg.queryPg("select value, source_label, source_date::text from crm_bulk_listing_fields where bulk_listing_id = $1 and field_key = 'manufacture_date'", [lotId]);
    expect(fact).toMatchObject({ value: "2021 to 2025", source_label: "Gmail · sam@supplier.test", source_date: "2026-09-29" });
    expect(await pg.queryPg("select name, stage from crm_bulk_offers where bulk_listing_id = $1 and role = 'counterparty' order by created_at", [lotId]))
      .toEqual([{ name: "Synthetic Buyer", stage: "offered" }, { name: "New Buyer Co", stage: "candidate" }]);
    expect((await pg.queryPg("select next_action, next_due::text from crm_bulk_listings where id = $1", [lotId]))[0])
      .toEqual({ next_action: "Ask for the address", next_due: "2026-10-01" });
    expect(await pg.queryPg("select file_name, doc_type, visibility from crm_bulk_listing_documents where bulk_listing_id = $1", [lotId]))
      .toEqual([{ file_name: "spec.pdf", doc_type: "Datasheet", visibility: "never" }]);
    expect(await pg.queryPg("select contact from crm_bulk_offers where bulk_listing_id = $1 and role = 'contact'", [lotId]))
      .toEqual([{ contact: "sam@supplier.test" }]);
    expect(await proposals.tradeProposals(lotId)).toEqual([]);
    // Decisions are logged on the Trades Preview listing's History, not the old Bulk Trades events.
    const logged = await pg.queryPg<{ title: string }>(
      "select title from crm_bulk_listing_activity where bulk_listing_id = $1 and kind = 'status' and data ? 'proposal_id'", [lotId]);
    expect(logged.filter((row) => row.title.startsWith("Proposal accepted"))).toHaveLength(6);
  });

  it("applies a proposal once however often it is clicked, and ignores without changing anything", async () => {
    const id = await propose("next_step", null, { next_step: "Clicked twice" });
    const [first, second] = await Promise.all([
      proposals.decideProposal(id, "accept", user), proposals.decideProposal(id, "accept", user),
    ]);
    expect([first.ok, second.ok].sort()).toEqual([false, true]);

    const ignored = await propose("field", "location", { value: "Turin" });
    await proposals.decideProposal(ignored, "ignore", user);
    expect(await pg.queryPg("select 1 from crm_bulk_listing_fields where bulk_listing_id = $1 and field_key = 'location'", [lotId])).toEqual([]);
  });

  it("approves incomplete asks as qualifying and reconfirms the same entity/family instead of inserting", async () => {
    const email = `demand-${crypto.randomUUID()}@example.test`;
    const initial = await propose("possible_demand", null, {
      buyer: "Demand Buyer", email, wants: "Leaf packs", product_family: "nissan leaf", kind: "request",
      reputation: "inbound", volume: 20, volume_unit: "packs", quantity: "20 packs",
    }, null);
    expect(await proposals.decideProposal(initial, "accept", user)).toMatchObject({ ok: true });
    const [first] = await pg.queryPg<{ id: string; status: string }>(
      "select id, status from crm_bulk_demand where email = $1", [email]);
    expect(first.status).toBe("qualifying");
    const followup = await propose("possible_demand", null, {
      buyer: "Demand Buyer", email, wants: "Another Leaf batch", product_family: "nissan leaf", kind: "request",
      max_price: 1000, price_currency: "EUR", price_unit: "pack",
      price_basis: "buyer", reputation: "email", existing_demand_id: first.id,
    }, null);
    expect(await proposals.decideProposal(followup, "accept", user)).toMatchObject({ ok: true });
    expect(await pg.queryPg("select id, status, wants, fee_eur::float8 from crm_bulk_demand where email = $1", [email]))
      .toEqual([{ id: first.id, status: "open", wants: "Another Leaf batch", fee_eur: 2000 }]);
    const changed = await propose("possible_demand", null, {
      buyer: "Demand Buyer", email, wants: "Another Leaf batch", product_family: "nissan leaf",
      volume: 10, volume_unit: "packs", existing_demand_id: first.id,
    }, null);
    expect(await proposals.decideProposal(changed, "accept", user)).toMatchObject({ ok: true });
    expect((await pg.queryPg<{ fee: number }>("select fee_eur::float8 as fee from crm_bulk_demand where id = $1", [first.id]))[0].fee).toBe(1000);
    const foreignCurrency = await propose("possible_demand", null, {
      buyer: "Demand Buyer", email, wants: "Another Leaf batch", product_family: "nissan leaf",
      max_price: 1000, price_currency: "USD", price_unit: "pack", existing_demand_id: first.id,
    }, null);
    expect(await proposals.decideProposal(foreignCurrency, "accept", user)).toMatchObject({ ok: true });
    expect((await pg.queryPg("select fee_eur from crm_bulk_demand where id = $1", [first.id]))[0].fee_eur).toBeNull();
  });

  it("undoes demand inserts and updates without a trade, and refuses conflicting human edits", async () => {
    const email = `undo-demand-${crypto.randomUUID()}@example.test`;
    const first = await propose("possible_demand", null, {
      buyer:"Synthetic undo buyer",email,wants:"100 cells",quantity:"100 cells",product_family:"lfp cells",
    }, null);
    expect(await proposals.decideProposal(first,"accept",user)).toEqual({ok:true,lot_id:null});
    const [created] = await pg.queryPg<{id:string}>("select id from crm_bulk_demand where email=$1",[email]);
    const update = await propose("possible_demand",null,{
      buyer:"Synthetic undo buyer",email,wants:"200 cells",quantity:"200 cells",product_family:"lfp cells",
    },null);
    expect(await proposals.decideProposal(update,"accept",user)).toEqual({ok:true,lot_id:null});
    expect(await proposals.undoChange(update,user.id)).toEqual({ok:true,lot_id:null});
    expect((await pg.queryPg("select wants from crm_bulk_demand where id=$1",[created.id]))[0].wants).toBe("100 cells");
    // Restoring the exact before snapshot permits undoing the earlier insert too.
    expect(await proposals.undoChange(first,user.id)).toEqual({ok:true,lot_id:null});
    expect(await pg.queryPg("select id from crm_bulk_demand where id=$1",[created.id])).toEqual([]);
    const conflict = await propose("possible_demand",null,{buyer:"Synthetic undo buyer",email,wants:"300 cells"},null);
    expect((await proposals.decideProposal(conflict,"accept",user)).ok).toBe(true);
    await pg.queryPg("update crm_bulk_demand set wants='Human edit',updated_at=now() where email=$1",[email]);
    expect(await proposals.undoChange(conflict,user.id)).toMatchObject({ok:false,status:409});
    expect((await pg.queryPg("select wants from crm_bulk_demand where email=$1",[email]))[0].wants).toBe("Human edit");
  });

  it("revalidates WhatsApp source versions and identity mapping at acceptance", async () => {
    const key = crypto.randomUUID();
    const person = `wa-person-${key}`, identity = `wa-identity-${key}`, thread = `wa-thread-${key}`, message = `wa-message-${key}`;
    await pg.queryPg("insert into crm_people(id,full_name) values($1,'Synthetic mapped buyer')",[person]);
    await pg.queryPg("insert into whatsapp_account(id,account_jid) values($1,$2)",[key,`${key}@synthetic.test`]);
    await pg.queryPg("insert into whatsapp_identity(id,account_id,canonical_jid) values($1,$2,$3)",[identity,key,`${key}@lid`]);
    await pg.queryPg(`insert into whatsapp_identity_link(id,account_id,identity_id,person_id,method,confidence,evidence,actor)
      values($1,$2,$3,$4,'manual','confirmed','{}','test')`,[key,key,identity,person]);
    await pg.queryPg(`insert into whatsapp_thread(id,account_id,canonical_chat_id,identity_id,kind,first_captured_at,last_captured_at)
      values($1,$2,$3,$4,'direct',now(),now())`,[thread,key,`${key}@lid`,identity]);
    await pg.queryPg(`insert into whatsapp_message(id,account_id,thread_id,provider_message_id,sender_identity_id,direction,captured_at,body)
      values($1,$2,$3,'synthetic-message',$4,'inbound',now(),'Synthetic request for LFP cells')`,[message,key,thread,identity]);
    const [{version}] = await pg.queryPg<{version:string}>("select whatsapp_source_version(m) as version from whatsapp_message m where id=$1",[message]);
    const [{id}] = await pg.queryPg<{id:string}>(`insert into crm_bulk_trade_proposals(kind,proposed,summary,quote,source_kind,source_id,source_label)
      values('possible_demand',$1,'Synthetic request','Synthetic request','whatsapp',$2,'WhatsApp') returning id::text`,[
      JSON.stringify({buyer:"Synthetic mapped buyer",person_id:person,wants:"LFP cells",source_version:version}),message]);
    await pg.queryPg("update whatsapp_identity_link set valid_to=now() where id=$1",[key]);
    expect(await proposals.decideProposal(id,"accept",user)).toMatchObject({ok:false,status:422});
    await pg.queryPg("update whatsapp_identity_link set valid_to=null where id=$1",[key]);
    expect(await proposals.decideProposal(id,"accept",user)).toEqual({ok:true,lot_id:null});
    expect((await pg.queryPg("select source_kind,source_id from crm_bulk_demand where person_id=$1",[person]))[0])
      .toEqual({source_kind:"whatsapp",source_id:message});
    expect(await proposals.undoChange(id,user.id)).toEqual({ok:true,lot_id:null});
    await pg.queryPg("update crm_bulk_trade_proposals set status='new' where id=$1",[id]);
    await pg.queryPg("update whatsapp_message set body='Edited synthetic request',edit_version=1 where id=$1",[message]);
    expect((await pg.queryPg("select status,quote from crm_bulk_trade_proposals where id=$1",[id]))[0]).toEqual({status:"ignored",quote:""});
    expect(await proposals.decideProposal(id,"accept",user)).toMatchObject({ok:false,status:404});
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
    // A possible trade becomes an open supply listing in Trades Preview.
    const [created] = await pg.queryPg<Record<string, unknown>>(
      "select kind, status, summary, next_action, spec, context->>'listing_title' as title from crm_bulk_listings where id = $1",
      [(result as { lot_id: string }).lot_id]);
    expect(created).toMatchObject({ kind: "supply", status: "open", summary: "Leaf packs, Leeds", title: "Leaf packs, Leeds",
      next_action: "Qualify this lead", spec: { trade_kind: "packs" } });
  });

  it("reads a new contact's history, and fills a trade created from a possible new trade", async () => {
    startHistoryPass.mockClear();
    await proposals.decideProposal(await propose("link_contact", null, { name: "Nic", email: "nic@oem.test" }), "accept", user);
    expect(startHistoryPass).toHaveBeenCalledWith(lotId);

    const id = await propose("possible_trade", null, { title: "Kona packs, Wales", trade_kind: "packs", email: "seller@kona.test" }, null);
    const result = await proposals.decideProposal(id, "accept", user) as { ok: true; lot_id: string };
    const contacts = await pg.queryPg<{ role: string; contact: string }>(
      "select role, contact from crm_bulk_offers where bulk_listing_id = $1", [result.lot_id]);
    expect(contacts).toEqual([{ role: "contact", contact: "seller@kona.test" }]);

    const kindless = (await trades.createBulkTrade({ title: "Kindless" }, user.id)).id;
    await proposals.decideProposal(await propose("trade_kind", null, { trade_kind: "cells" }, kindless), "accept", user);
    expect((await pg.queryPg("select spec->>'trade_kind' as kind from crm_bulk_listings where id = $1", [kindless]))[0]).toEqual({ kind: "cells" });
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
      const [event] = await pg.queryPg<{ title: string; actor_user_id: string }>(
        "select title, actor_user_id from crm_bulk_listing_activity where bulk_listing_id = $1 order by id desc limit 1", [undoLot]);
      expect(event).toMatchObject({ actor_user_id: user.id });
      expect(event.title).toMatch(/^Inbox change undone/);
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

describe("duplicateStockFor (REB-566)", () => {
  it("asks nothing when the seller is unknown, otherwise passes company, person and title", async () => {
    vi.resetModules();
    vi.doMock("../postgres", () => ({ queryPg: vi.fn(), withPgTransaction: vi.fn() }));
    const { duplicateStockFor } = await import("./bulk-trade-proposals");
    const query = vi.fn(async () => ({ rows: [{ id: "sto_1", title: "SP05" }] }));
    expect(await duplicateStockFor({ query } as never, null, null, "SP05 system")).toEqual([]);
    expect(query).not.toHaveBeenCalled();
    expect(await duplicateStockFor({ query } as never, "c1", null, "SP05 system")).toEqual([{ id: "sto_1", title: "SP05" }]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("crm_stock_opportunities"), ["c1", null, "SP05 system"]);
  });
});
