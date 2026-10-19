import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Runs only against a disposable database: scripts/rebattery/crm-test-db.sh up prints the URL.
const TEST_URL = process.env.BULK_TRADES_TEST_DATABASE_URL;

describe.skipIf(!TEST_URL)("sheet list", () => {
  let pg: typeof import("../postgres");
  let sheet: typeof import("./bulk-sheet");

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_URL;
    pg = await import("../postgres");
    sheet = await import("./bulk-sheet");
    await pg.queryPg(`
      delete from crm_bulk_trade_demand where id like 'btd_sheet_%';
      delete from crm_bulk_trade_supply where id like 'bts_sheet_%';
      delete from crm_bulk_trade_lots where id like 'btl_sheet_%';
      insert into crm_bulk_trade_demand (id, buyer, wants, kind, basis, product_family) values
        ('btd_sheet_new', 'New Buyer', '12 Ioniq packs', 'request', null, 'Ioniq'),
        ('btd_sheet_worked', 'Worked Buyer', 'LFP systems', 'standing', 'stated', null),
        ('btd_sheet_closed', 'Closed Buyer', 'Anything', 'standing', 'stated', null),
        ('btd_sheet_qual', 'Qualifying Buyer', 'Something vague', 'standing', 'stated', null);
      update crm_bulk_trade_demand set status = 'closed', closed_reason = 'other' where id = 'btd_sheet_closed';
      update crm_bulk_trade_demand set status = 'qualifying' where id = 'btd_sheet_qual';
      insert into crm_bulk_trade_demand_activity (demand_id, kind, title, occurred_at) values
        ('btd_sheet_worked', 'research', 'Found two sources', '2026-10-01'),
        ('btd_sheet_worked', 'outreach', 'Asked supplier A', '2026-10-05');
      insert into crm_bulk_trade_supply (id, seller, offers, observed_on) values ('bts_sheet_open', 'Seller Ltd', '3 hybrid packs', '2026-10-07');
      insert into crm_bulk_trade_supply (id, seller, offers, status, closed_reason) values ('bts_sheet_shut', 'Gone Ltd', 'Old cells', 'closed', 'gone');
      insert into crm_bulk_trade_lots (id, title, trade_stage, origin, lot_kind, summary, observed_outcome, confidence) values
        ('btl_sheet_live', 'Live lot', 'With buyers', 'supply', 'supply', 'x', 'x', 'probable'),
        ('btl_sheet_done', 'Done lot', 'Done', 'supply', 'supply', 'x', 'x', 'probable');
    `);
  });

  afterAll(async () => {
    await pg.pgPool.end();
  });

  it("lists open demand, open offers and live trades once each, and leaves history, qualifying and finished work out", async () => {
    const rows = (await sheet.listSheet()).filter((row) => /^(btd|bts|btl)_sheet_/.test(row.id));
    expect(rows.map((row) => row.key).sort()).toEqual(
      ["demand:btd_sheet_new", "demand:btd_sheet_worked", "supply:bts_sheet_open", "trade:btl_sheet_live"].sort());
    const worked = rows.find((row) => row.id === "btd_sheet_worked")!;
    expect(worked).toMatchObject({ progress: "Being worked", latest: { label: "Asked supplier A", kind: "Outreach" }, next_action: null, owner: null });
    expect(rows.find((row) => row.id === "btd_sheet_new")).toMatchObject({ progress: "New", latest: null });
  });
});
