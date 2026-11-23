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
      delete from crm_bulk_demand where id like 'btd_sheet_%';
      delete from crm_bulk_supply where id like 'bts_sheet_%';
      delete from crm_bulk_listings where id like 'btl_sheet_%';
      insert into crm_bulk_demand (id, buyer, wants, kind, basis, product_family) values
        ('btd_sheet_new', 'New Buyer', '12 Ioniq packs', 'request', null, 'Ioniq'),
        ('btd_sheet_worked', 'Worked Buyer', 'LFP systems', 'standing', 'stated', null),
        ('btd_sheet_closed', 'Closed Buyer', 'Anything', 'standing', 'stated', null),
        ('btd_sheet_qual', 'Qualifying Buyer', 'Something vague', 'standing', 'stated', null);
      update crm_bulk_demand set status = 'closed', closed_reason = 'other' where id = 'btd_sheet_closed';
      update crm_bulk_demand set status = 'qualifying' where id = 'btd_sheet_qual';
      insert into crm_bulk_listing_activity (bulk_listing_id, kind, title, occurred_at) values
        ('btd_sheet_worked', 'research', 'Found two sources', '2026-10-01'),
        ('btd_sheet_worked', 'outreach', 'Asked supplier A', '2026-10-05');
      insert into crm_bulk_supply (id, seller, offers, observed_on) values ('bts_sheet_open', 'Seller Ltd', '3 hybrid packs', '2026-10-07');
      insert into crm_bulk_supply (id, seller, offers, status, closed_reason) values ('bts_sheet_shut', 'Gone Ltd', 'Old cells', 'closed', 'gone');
      insert into crm_bulk_listings (id, kind, party, summary, status, closed_reason, context) values
        ('btl_sheet_live', 'supply', 'Lot Seller', 'Live lot', 'open', null, '{"from_bulk_trade_lot": true}'),
        ('btl_sheet_done', 'supply', 'Lot Seller', 'Done lot', 'closed', 'other', '{"from_bulk_trade_lot": true}');
      insert into crm_bulk_offers (id, bulk_listing_id, counterpart_id, role, stage) values
        ('bof_sheet_contact', 'bts_sheet_open', null, 'counterparty', 'candidate'),
        ('bof_sheet_bid', 'bts_sheet_open', null, 'counterparty', 'offered'),
        ('bof_sheet_loi', 'bts_sheet_open', 'btd_sheet_new', 'counterparty', 'contract_out');
    `);
  });

  afterAll(async () => {
    await pg.pgPool.end();
  });

  it("lists open and qualifying demand, open offers and live trades once each, and leaves history and finished work out", async () => {
    const rows = (await sheet.listSheet()).filter((row) => /^(btd|bts|btl)_sheet_/.test(row.id));
    expect(rows.map((row) => `${row.kind}:${row.id}`).sort()).toEqual(
      ["demand:btd_sheet_new", "demand:btd_sheet_qual", "demand:btd_sheet_worked", "supply:bts_sheet_open", "supply:btl_sheet_live"].sort());
    const worked = rows.find((row) => row.id === "btd_sheet_worked")!;
    expect(worked).toMatchObject({ progress: "New", latest: { label: "Asked supplier A", kind: "Outreach" }, next_action: null, owner: null });
    expect(rows.find((row) => row.id === "btd_sheet_qual")).toMatchObject({ progress: "New", side: "buyer" });
    expect(rows.find((row) => row.id === "btd_sheet_new")).toMatchObject({ progress: "Agreed", tone: "closing", side: "buyer", latest: null });
    expect(rows.find((row) => row.id === "bts_sheet_open")).toMatchObject({ progress: "Agreed", tone: "closing", side: "seller" });
    // The furthest live offer links the supply and the demand, so each names the other.
    expect(rows.find((row) => row.id === "bts_sheet_open")?.paired_listing_id).toBe("btd_sheet_new");
    expect(rows.find((row) => row.id === "btd_sheet_new")?.paired_listing_id).toBe("bts_sheet_open");
    expect(worked.paired_listing_id).toBeNull();
    expect(rows.filter((row) => row.id === "btl_sheet_live")).toHaveLength(1);
    expect(rows.find((row) => row.id === "btl_sheet_live")).toMatchObject({ kind: "supply", side: "seller" });
  });

  it("pairs nothing through a declined or lost offer", async () => {
    await pg.queryPg(`
      insert into crm_bulk_listings (id, kind, party, summary, status) values ('btl_sheet_dec', 'supply', 'Lot Seller', 'Declined lot', 'open')
        on conflict (id) do nothing;
      insert into crm_bulk_offers (id, bulk_listing_id, counterpart_id, role, stage) values ('bof_sheet_dec', 'btl_sheet_dec', 'btd_sheet_worked', 'counterparty', 'declined')
        on conflict (id) do update set stage = excluded.stage;`);
    const rows = await sheet.listSheet();
    expect(rows.find((row) => row.id === "btl_sheet_dec")).toMatchObject({ paired_listing_id: null, is_trade: false });
    expect(rows.find((row) => row.id === "btd_sheet_worked")?.paired_listing_id).toBeNull();
  });

  it("lists listings closed in the last 30 days, newest first, and leaves housekeeping closures out", async () => {
    await pg.queryPg(`
      delete from crm_bulk_listings where id like 'btl_closed_%';
      insert into crm_bulk_listings (id, kind, party, summary, status) values
        ('btl_closed_new', 'demand', 'Quiet Buyer', 'Packs', 'open'), ('btl_closed_recent', 'demand', 'Recent Buyer', 'Packs', 'open'),
        ('btl_closed_old', 'demand', 'Old Buyer', 'Packs', 'open'), ('btl_closed_dup', 'demand', 'Dup Buyer', 'Packs', 'open'),
        ('btl_closed_open', 'demand', 'Open Buyer', 'Packs', 'open');
      update crm_bulk_listings set status = 'closed', closed_reason = 'no_longer_needed' where id = 'btl_closed_new';
      update crm_bulk_listings set status = 'closed', closed_reason = 'expired' where id in ('btl_closed_recent', 'btl_closed_old');
      update crm_bulk_listings set status = 'closed', closed_reason = 'duplicate' where id = 'btl_closed_dup';
      -- Closing logs a "Closed" story entry; back-date them. An edit made today must not bring an old closure back.
      update crm_bulk_listing_activity set occurred_at = now() - interval '2 days' where bulk_listing_id = 'btl_closed_new' and kind = 'status';
      update crm_bulk_listing_activity set occurred_at = now() - interval '5 days' where bulk_listing_id = 'btl_closed_recent' and kind = 'status';
      update crm_bulk_listing_activity set occurred_at = now() - interval '35 days' where bulk_listing_id = 'btl_closed_old' and kind = 'status';
      update crm_bulk_listings set updated_at = now() where id = 'btl_closed_old';
    `);
    const closed = (await sheet.listClosed()).filter((row) => row.id.startsWith("btl_closed_"));
    // The story's Closed entry wins over updated_at: "old" was closed 35 days ago even though it was edited today.
    expect(closed.map((row) => row.id)).toEqual(["btl_closed_new", "btl_closed_recent"]);
    expect(closed[0]).toMatchObject({ closed_reason: "no_longer_needed" });
    expect(closed[0].closed_at).toBeTruthy();
    // Closed listings never reach the working sheet.
    expect((await sheet.listSheet()).filter((row) => row.id.startsWith("btl_closed_")).map((row) => row.id)).toEqual(["btl_closed_open"]);
    await pg.queryPg("delete from crm_bulk_listings where id like 'btl_closed_%'");
  });
});
