import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Runs only against a disposable database: scripts/rebattery/crm-test-db.sh up prints the URL.
const TEST_URL = process.env.BULK_TRADES_TEST_DATABASE_URL;

describe.skipIf(!TEST_URL)("supply list", () => {
  let pg: typeof import("../postgres");
  let supply: typeof import("./bulk-supply");
  let demand: typeof import("./bulk-demand");

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_URL;
    pg = await import("../postgres");
    supply = await import("./bulk-supply");
    demand = await import("./bulk-demand");
    await pg.queryPg(`
      delete from crm_bulk_supply where id like 'bts_sup_%';
      delete from crm_bulk_demand where id like 'btd_sup_%';
      insert into crm_bulk_demand (id, buyer, contact, wants, kind, basis) values
        ('btd_sup_a', 'Lab Buyer', 'Massimo', 'Two 60 kWh packs for testing', 'request', null),
        ('btd_sup_b', 'Other Buyer', null, 'Hybrid packs', 'standing', 'stated'),
        ('btd_sup_c', 'Closed Buyer', null, 'Anything', 'standing', 'stated');
      update crm_bulk_demand set status = 'closed', closed_reason = 'other' where id = 'btd_sup_c';
      insert into crm_bulk_supply (id, seller, offers, est_tonnes, observed_on) values
        ('bts_sup_1', 'Dismantler Ltd', '3 Prius hybrid packs', 0.12, '2026-10-07'),
        ('bts_sup_2', 'Older Seller', '20 18650 cells', null, '2026-10-01');
      insert into crm_bulk_trade_supply_matches (supply_id, demand_id, strength, reason) values
        ('bts_sup_1', 'btd_sup_a', 'partial', 'Packs, but hybrid'),
        ('bts_sup_1', 'btd_sup_b', 'strong', 'Hybrid packs'),
        ('bts_sup_1', 'btd_sup_c', 'strong', 'Closed row');
    `);
  });

  afterAll(async () => {
    await pg.pgPool.end();
  });

  it("lists batches newest first with open, visible fits, strong first", async () => {
    const rows = (await supply.listSupply()).filter((row) => row.id.startsWith("bts_sup_"));
    expect(rows.map((row) => row.id)).toEqual(["bts_sup_1", "bts_sup_2"]);
    expect(rows[0]).toMatchObject({ est_tonnes: 0.12, est_value_usd: null, observed_on: "2026-10-07", status: "open" });
    expect(rows[0].fits.map((fit) => [fit.buyer, fit.strength])).toEqual([["Other Buyer", "strong"], ["Lab Buyer", "partial"]]);
  });

  it("unifies sell-side lots, live auctions and supply batches", async () => {
    await pg.queryPg(`
      insert into crm_bulk_trade_lots (id, title, lot_kind, origin, summary, observed_outcome, confidence, auction_id, auction_status, auction_closes_at) values
        ('bulk_feed_sell', 'Feed sell-side lot', 'supply', 'supply', '', '', 'confirmed', null, null, null),
        ('bulk_feed_demand', 'Feed demand-origin lot', 'demand', 'demand', '', '', 'confirmed', null, null, null),
        ('bulk_feed_auction', 'Feed auction lot', 'supply', 'supply', '', '', 'confirmed', gen_random_uuid(), 'published', '2099-01-01'),
        ('bulk_feed_expired', 'Feed expired auction', 'supply', 'supply', '', '', 'confirmed', gen_random_uuid(), 'published', '2000-01-01');
    `);
    const rows = await supply.listSupplyFeed();
    expect(rows.find((row) => row.id === "bulk_feed_sell")).toMatchObject({ kind: "trade", title: "Feed sell-side lot", size: null });
    expect(rows.find((row) => row.id === "bulk_feed_auction")).toMatchObject({ kind: "auction" });
    expect(rows.some((row) => row.id === "bulk_feed_demand" || row.id === "bulk_feed_expired")).toBe(false);
    expect(rows.some((row) => row.id.startsWith("stock:"))).toBe(false);
    expect(rows.find((row) => row.id === "bts_sup_1")).toMatchObject({ kind: "supply" });
  });

  it("exposes dated company context on both sheets without copying it into demand", async () => {
    await pg.queryPg(`
      insert into crm_companies (id, name) values ('company_feed_context', 'Context Company');
      insert into crm_company_context_notes (id, company_id, note, source_kind, source_ref, observed_on) values
        ('context_feed_old', 'company_feed_context', 'Earlier call', 'call', 'transcript:earlier', '2026-09-01'),
        ('context_feed_new', 'company_feed_context', 'Latest call', 'call', 'transcript:latest', '2026-10-16');
      update crm_company_context_notes set category='bid', source_url='https://example.com/evidence'
        where id='context_feed_new';
      update crm_bulk_supply set company_id = 'company_feed_context' where id = 'bts_sup_1';
      update crm_bulk_demand set company_id = 'company_feed_context' where id = 'btd_sup_a';
    `);
    // DATABASE_URL is assigned in beforeAll; static import would initialize the pool too early.
    const { listCompanyContextNotes } = await import("./company-context");
    const notes = await listCompanyContextNotes("company_feed_context");
    expect(notes.map((note) => note.note)).toEqual(["Latest call", "Earlier call"]);
    expect(notes[0]).toMatchObject({ category: "bid", source_url: "https://example.com/evidence", source_ref: "transcript:latest", observed_on: "2026-10-16" });
    expect((await supply.getSupply("bts_sup_1"))?.context_notes).toEqual(notes);
    expect((await demand.getDemand("btd_sup_a"))?.context_notes).toEqual(notes);
    expect(await listCompanyContextNotes("company_missing")).toEqual([]);
  });

  it("hides a fit, closes and reopens a batch", async () => {
    const hidden = await supply.hideSupplyFit("bts_sup_1", "btd_sup_b");
    expect(hidden?.fits.map((fit) => fit.buyer)).toEqual(["Lab Buyer"]);
    expect(await supply.closeSupply("bts_sup_1", "sold")).toMatchObject({ status: "closed", closed_reason: "sold" });
    const rows = (await supply.listSupply()).filter((row) => row.id.startsWith("bts_sup_"));
    expect(rows.map((row) => row.id)).toEqual(["bts_sup_2", "bts_sup_1"]); // open first
    await pg.queryPg("update crm_bulk_supply set match_hash = 'judged' where id = 'bts_sup_1'");
    expect(await supply.reopenSupply("bts_sup_1")).toMatchObject({ status: "open", closed_reason: null });
    // Closing dropped its suggestions, so reopening has the next matching pass judge it again.
    const [hash] = await pg.queryPg<{ match_hash: string | null }>("select match_hash from crm_bulk_supply where id = 'bts_sup_1'");
    expect(hash.match_hash).toBeNull();
    expect(await supply.closeSupply("bts_missing", "sold")).toBeNull();
  });

  it("clears a reopened demand row's matching hashes, but not on a plain Still wanted", async () => {
    await pg.queryPg("update crm_bulk_demand set match_hash = 'm', supply_match_hash = 's' where id in ('btd_sup_b', 'btd_sup_c')");
    await demand.confirmDemand("btd_sup_c"); // was closed
    await demand.confirmDemand("btd_sup_b"); // was open
    const rows = await pg.queryPg<{ id: string; match_hash: string | null; supply_match_hash: string | null }>(
      "select id, match_hash, supply_match_hash from crm_bulk_demand where id in ('btd_sup_b', 'btd_sup_c') order by id",
    );
    expect(rows).toEqual([
      { id: "btd_sup_b", match_hash: "m", supply_match_hash: "s" },
      { id: "btd_sup_c", match_hash: null, supply_match_hash: null },
    ]);
  });
});
