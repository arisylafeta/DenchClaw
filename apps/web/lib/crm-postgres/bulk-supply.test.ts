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
      delete from crm_bulk_trade_supply where id like 'bts_sup_%';
      delete from crm_bulk_trade_demand where id like 'btd_sup_%';
      insert into crm_bulk_trade_demand (id, buyer, contact, wants, kind, basis) values
        ('btd_sup_a', 'Lab Buyer', 'Massimo', 'Two 60 kWh packs for testing', 'request', null),
        ('btd_sup_b', 'Other Buyer', null, 'Hybrid packs', 'standing', 'stated'),
        ('btd_sup_c', 'Closed Buyer', null, 'Anything', 'standing', 'stated');
      update crm_bulk_trade_demand set status = 'closed', closed_reason = 'other' where id = 'btd_sup_c';
      insert into crm_bulk_trade_supply (id, seller, offers, est_tonnes, observed_on) values
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

  it("hides a fit, closes and reopens a batch", async () => {
    const hidden = await supply.hideSupplyFit("bts_sup_1", "btd_sup_b");
    expect(hidden?.fits.map((fit) => fit.buyer)).toEqual(["Lab Buyer"]);
    expect(await supply.closeSupply("bts_sup_1", "sold")).toMatchObject({ status: "closed", closed_reason: "sold" });
    const rows = (await supply.listSupply()).filter((row) => row.id.startsWith("bts_sup_"));
    expect(rows.map((row) => row.id)).toEqual(["bts_sup_2", "bts_sup_1"]); // open first
    await pg.queryPg("update crm_bulk_trade_supply set match_hash = 'judged' where id = 'bts_sup_1'");
    expect(await supply.reopenSupply("bts_sup_1")).toMatchObject({ status: "open", closed_reason: null });
    // Closing dropped its suggestions, so reopening has the next matching pass judge it again.
    const [hash] = await pg.queryPg<{ match_hash: string | null }>("select match_hash from crm_bulk_trade_supply where id = 'bts_sup_1'");
    expect(hash.match_hash).toBeNull();
    expect(await supply.closeSupply("bts_missing", "sold")).toBeNull();
  });

  it("clears a reopened demand row's matching hashes, but not on a plain Still wanted", async () => {
    await pg.queryPg("update crm_bulk_trade_demand set match_hash = 'm', supply_match_hash = 's' where id in ('btd_sup_b', 'btd_sup_c')");
    await demand.confirmDemand("btd_sup_c"); // was closed
    await demand.confirmDemand("btd_sup_b"); // was open
    const rows = await pg.queryPg<{ id: string; match_hash: string | null; supply_match_hash: string | null }>(
      "select id, match_hash, supply_match_hash from crm_bulk_trade_demand where id in ('btd_sup_b', 'btd_sup_c') order by id",
    );
    expect(rows).toEqual([
      { id: "btd_sup_b", match_hash: "m", supply_match_hash: "s" },
      { id: "btd_sup_c", match_hash: null, supply_match_hash: null },
    ]);
  });
});
