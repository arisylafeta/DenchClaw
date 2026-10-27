import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Runs only against a disposable database: scripts/rebattery/crm-test-db.sh up prints the URL.
const TEST_URL = process.env.BULK_TRADES_TEST_DATABASE_URL;

describe.skipIf(!TEST_URL)("bulk_listing_stage", () => {
  let pg: typeof import("../postgres");
  const stage = async (id: string) => (await pg.queryPg<{ s: string }>("select bulk_listing_stage($1) as s", [id]))[0].s;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_URL;
    pg = await import("../postgres");
    await pg.queryPg(`
      delete from crm_bulk_listings where id like 'stg_%';
      delete from crm_companies where id = 'stg_company';
      insert into crm_companies (id, name) values ('stg_company', 'Stage Test Co');
      insert into crm_bulk_listings (id, kind, party, summary, status, quantity, location, company_id, spec) values
        ('stg_new', 'supply', 'Seller', 'Bare lot', 'open', null, null, null, '{}'),
        ('stg_ready', 'supply', 'Seller', 'Ready lot', 'open', '40', 'Leeds', 'stg_company', '{}'),
        ('stg_partial', 'supply', 'Seller', 'No test data', 'open', '40', 'Leeds', 'stg_company', '{}'),
        ('stg_demand', 'demand', 'Buyer', 'Packs', 'open', '10', null, 'stg_company', '{"intent": "request", "product_family": "Ioniq"}'),
        ('stg_asked', 'demand', 'Buyer', 'Packs', 'qualifying', '10', null, 'stg_company', '{"intent": "request", "product_family": "Ioniq"}');
      insert into crm_bulk_listing_fields (bulk_listing_id, field_key, value, status, visibility) values
        ('stg_ready', 'soh', '92%', 'confirmed', 'never'), ('stg_partial', 'soh', null, 'missing', 'never');
    `);
  });
  afterAll(async () => {
    await pg.queryPg("delete from crm_bulk_listings where id like 'stg_%'; delete from crm_companies where id = 'stg_company';");
    await pg.pgPool.end();
  });

  it("is New until the basics are in, then Qualified", async () => {
    expect(await stage("stg_new")).toBe("New");
    expect(await stage("stg_partial")).toBe("New");
    expect(await stage("stg_ready")).toBe("Qualified");
    expect(await stage("stg_demand")).toBe("Qualified");
  });

  it("keeps a demand New while a qualifying question is open", async () => {
    expect(await stage("stg_asked")).toBe("New");
  });

  it("is Available (supply) or Found (demand) by a visible saved match, and a hidden one does not count", async () => {
    await pg.queryPg("insert into crm_bulk_trade_supply_matches (supply_id, demand_id, strength, reason, hidden) values ('stg_new', 'stg_demand', 'partial', 'x', true)");
    expect(await stage("stg_new")).toBe("New");
    await pg.queryPg("update crm_bulk_trade_supply_matches set hidden = false where supply_id = 'stg_new'");
    expect(await stage("stg_new")).toBe("Available");
    expect(await stage("stg_demand")).toBe("Found");
    await pg.queryPg("delete from crm_bulk_trade_supply_matches where supply_id = 'stg_new'");
  });

  it("moves a qualified listing on when it has an owner: demand to Sourcing, supply to Available", async () => {
    await pg.queryPg(`update crm_bulk_listings set context = context || '{"owner": "Sean"}' where id in ('stg_demand', 'stg_ready', 'stg_partial')`);
    expect(await stage("stg_demand")).toBe("Sourcing");
    expect(await stage("stg_ready")).toBe("Available");
    expect(await stage("stg_partial")).toBe("New"); // an owner alone does not qualify a listing
    await pg.queryPg(`update crm_bulk_listings set context = context - 'owner' where id in ('stg_demand', 'stg_ready', 'stg_partial')`);
    expect(await stage("stg_demand")).toBe("Qualified");
  });

  it("marks a demand Can't source while a reason is set, over Found, but never over a live deal", async () => {
    const reason = (text: string | null) => pg.queryPg(
      `update crm_bulk_listings set context = case when $2::text is null then context - 'cant_source' else jsonb_set(context, '{cant_source}', to_jsonb($2::text)) end where id = $1`, ["stg_demand", text]);
    await reason("No Ioniq packs in Europe this quarter");
    expect(await stage("stg_demand")).toBe("Can't source");
    await reason("   ");
    expect(await stage("stg_demand")).toBe("Qualified");
    await pg.queryPg("insert into crm_bulk_offers (id, bulk_listing_id, counterpart_id, role, stage) values ('stg_dc', 'stg_ready', 'stg_demand', 'counterparty', 'candidate')");
    await reason("Gone quiet");
    expect(await stage("stg_demand")).toBe("Can't source");
    await pg.queryPg("update crm_bulk_offers set stage = 'offered' where id = 'stg_dc'");
    expect(await stage("stg_demand")).toBe("Offered");
    await reason(null);
    await pg.queryPg("update crm_bulk_offers set stage = 'candidate' where id = 'stg_dc'");
    expect(await stage("stg_demand")).toBe("Found");
    await pg.queryPg("delete from crm_bulk_offers where id = 'stg_dc'");
  });

  it("follows the furthest offer for both kinds: Offered, Negotiating, Agreed, Paid, Delivered", async () => {
    const offer = (id: string, st: string) => pg.queryPg(
      "insert into crm_bulk_offers (id, bulk_listing_id, role, stage) values ($1, 'stg_ready', 'counterparty', $2) on conflict (id) do update set stage = excluded.stage", [id, st]);
    await offer("stg_o1", "candidate");
    expect(await stage("stg_ready")).toBe("Available");
    await offer("stg_o2", "declined");
    expect(await stage("stg_ready")).toBe("Available");
    await offer("stg_o1", "offered");
    expect(await stage("stg_ready")).toBe("Offered");
    await offer("stg_o1", "negotiating");
    expect(await stage("stg_ready")).toBe("Negotiating");
    for (const st of ["contract_out", "signed", "invoiced"]) {
      await offer("stg_o1", st);
      expect(await stage("stg_ready")).toBe("Agreed");
    }
    await offer("stg_o1", "paid");
    expect(await stage("stg_ready")).toBe("Paid");
    await offer("stg_o1", "complete");
    expect(await stage("stg_ready")).toBe("Delivered");
    await pg.queryPg("delete from crm_bulk_offers where id in ('stg_o1', 'stg_o2')");
  });

  it("an unknown listing is New", async () => {
    expect(await stage("stg_missing")).toBe("New");
  });

  it("rejects the retired offer stages and accepts negotiating", async () => {
    await expect(pg.queryPg("insert into crm_bulk_offers (id, bulk_listing_id, role, stage) values ('stg_bad', 'stg_ready', 'counterparty', 'bid_in')")).rejects.toThrow();
    await pg.queryPg("insert into crm_bulk_offers (id, bulk_listing_id, role, stage) values ('stg_neg', 'stg_ready', 'counterparty', 'negotiating')");
    expect((await pg.queryPg<{ stage: string }>("select stage from crm_bulk_offers where id = 'stg_neg'"))[0].stage).toBe("negotiating");
    await pg.queryPg("delete from crm_bulk_offers where id = 'stg_neg'");
  });
});
