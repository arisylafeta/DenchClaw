import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Runs only against a disposable database: scripts/rebattery/crm-test-db.sh up prints the URL.
const TEST_URL = process.env.BULK_TRADES_TEST_DATABASE_URL;

describe.skipIf(!TEST_URL)("bulk_listing_stage and bulk_listing_deal_stage (migration 111)", () => {
  let pg: typeof import("../postgres");
  const stage = async (id: string) => (await pg.queryPg<{ s: string | null }>("select bulk_listing_stage($1) as s", [id]))[0].s;
  const deal = async (id: string) => (await pg.queryPg<{ s: string | null }>("select bulk_listing_deal_stage($1) as s", [id]))[0].s;
  const offer = (id: string, listing: string, st: string, counterpart: string | null = null) => pg.queryPg(
    `insert into crm_bulk_offers (id, bulk_listing_id, counterpart_id, role, stage) values ($1, $2, $4, 'counterparty', $3)
     on conflict (id) do update set stage = excluded.stage`, [id, listing, st, counterpart]);

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

  it("is New until the basics are in, then Qualified for both kinds", async () => {
    expect(await stage("stg_new")).toBe("New");
    expect(await stage("stg_partial")).toBe("New");
    expect(await stage("stg_ready")).toBe("Qualified");
    expect(await stage("stg_demand")).toBe("Qualified");
    expect(await deal("stg_ready")).toBeNull();
  });

  it("keeps a demand New while a qualifying question is open", async () => {
    expect(await stage("stg_asked")).toBe("New");
  });

  it("no longer reads the retired match tables", async () => {
    const [{ n }] = await pg.queryPg<{ n: number }>(
      `select count(*)::int as n from pg_proc where prosrc like '%crm_bulk_trade_%'
       and proname in ('bulk_listing_stage', 'bulk_listing_deal_stage', 'bulk_listing_has_match', 'bulk_listing_offer_rank', 'bulk_listing_qualified')`);
    expect(n).toBe(0);
  });

  it("moves a qualified listing on when it has an owner: demand to Sourcing, supply to Available", async () => {
    await pg.queryPg(`update crm_bulk_listings set context = context || '{"owner": "Sean"}' where id in ('stg_demand', 'stg_ready', 'stg_partial')`);
    expect(await stage("stg_demand")).toBe("Sourcing");
    expect(await stage("stg_ready")).toBe("Available");
    expect(await stage("stg_partial")).toBe("New"); // an owner alone does not qualify a listing
    await pg.queryPg(`update crm_bulk_listings set context = context - 'owner' where id in ('stg_demand', 'stg_ready', 'stg_partial')`);
    expect(await stage("stg_demand")).toBe("Qualified");
  });

  it("counts a live counterparty offer as a match (bulk_listing_has_match): Sourcing and Available before anything is offered", async () => {
    await offer("stg_m", "stg_new", "candidate", "stg_demand");
    expect((await pg.queryPg<{ m: boolean }>("select bulk_listing_has_match('stg_new') as m"))[0].m).toBe(true);
    expect([await stage("stg_new"), await stage("stg_demand")]).toEqual(["Available", "Sourcing"]);
    await offer("stg_m", "stg_new", "declined", "stg_demand");
    expect([await stage("stg_new"), await stage("stg_demand")]).toEqual(["New", "Qualified"]);
    await pg.queryPg("delete from crm_bulk_offers where id = 'stg_m'");
  });

  it("keeps a Can't source reason as a tag: the stage does not change", async () => {
    const { setListingCantSource } = await import("./bulk-listing-cant-source");
    await setListingCantSource("stg_demand", "No Ioniq packs in Europe this quarter");
    expect(await stage("stg_demand")).toBe("Qualified");
    await setListingCantSource("stg_demand", null);
  });

  it("walks a deal: list stages Found (demand) and Available, Sold (supply); deal stages Offered to Delivered", async () => {
    const both = async () => [await stage("stg_ready"), await stage("stg_demand"), await deal("stg_ready"), await deal("stg_demand")];
    await offer("stg_o1", "stg_ready", "offered", "stg_demand");
    expect(await both()).toEqual(["Available", "Found", "Offered", "Offered"]);
    await offer("stg_o1", "stg_ready", "negotiating", "stg_demand");
    expect(await both()).toEqual(["Available", "Found", "Negotiating", "Negotiating"]);
    for (const st of ["contract_out", "signed", "invoiced"]) {
      await offer("stg_o1", "stg_ready", st, "stg_demand");
      expect(await both()).toEqual(["Available", "Found", "Agreed", "Agreed"]); // Reserved is the hold only, for now
    }
    await offer("stg_o1", "stg_ready", "paid", "stg_demand");
    expect(await both()).toEqual(["Sold", "Found", "Paid", "Paid"]);
  });

  it("closes both listings when the offer is complete: supply as sold, demand as bought from us", async () => {
    await offer("stg_o1", "stg_ready", "complete", "stg_demand");
    const rows = await pg.queryPg<{ id: string; status: string; closed_reason: string }>(
      "select id, status, closed_reason from crm_bulk_listings where id in ('stg_ready', 'stg_demand') order by id");
    expect(rows).toEqual([{ id: "stg_demand", status: "closed", closed_reason: "bought_from_us" }, { id: "stg_ready", status: "closed", closed_reason: "sold" }]);
    expect([await stage("stg_ready"), await stage("stg_demand"), await deal("stg_ready")]).toEqual(["Sold", "Closed", "Delivered"]);
    await pg.queryPg("delete from crm_bulk_offers where id = 'stg_o1'");
    await pg.queryPg("update crm_bulk_listings set status = 'open', closed_reason = null where id in ('stg_ready', 'stg_demand')");
  });

  it("is Lost on the board when every counterparty offer is declined or lost, and not while one is alive", async () => {
    await offer("stg_l1", "stg_partial", "declined");
    await offer("stg_l2", "stg_partial", "lost");
    expect(await deal("stg_partial")).toBe("Lost");
    await offer("stg_l3", "stg_partial", "candidate");
    expect(await deal("stg_partial")).toBeNull();
    await offer("stg_l3", "stg_partial", "offered");
    expect(await deal("stg_partial")).toBe("Offered");
    await pg.queryPg("delete from crm_bulk_offers where id in ('stg_l1', 'stg_l2', 'stg_l3')");
    expect(await deal("stg_partial")).toBeNull();
  });

  it("is Reserved while a supply hold runs, and a closed supply that did not sell is Closed", async () => {
    await pg.queryPg("update crm_bulk_listings set hold_until = current_date + 2 where id = 'stg_new'");
    expect(await stage("stg_new")).toBe("Reserved");
    await pg.queryPg("update crm_bulk_listings set hold_until = current_date - 1 where id = 'stg_new'");
    expect(await stage("stg_new")).toBe("New");
    await pg.queryPg("update crm_bulk_listings set status = 'closed', closed_reason = 'gone' where id = 'stg_new'");
    expect(await stage("stg_new")).toBe("Closed");
    await pg.queryPg("update crm_bulk_listings set status = 'open', closed_reason = null, hold_until = null where id = 'stg_new'");
  });

  it("stores a fee override on either kind as a number, and clears it", async () => {
    const { setListingFee } = await import("./bulk-listing-fee");
    const fee = async (id: string) => (await pg.queryPg<{ fee: unknown }>("select context->'fee_eur' as fee from crm_bulk_listings where id = $1", [id]))[0].fee;
    expect(await setListingFee("stg_demand", 4200)).toBe(true);
    expect(await setListingFee("stg_ready", 0)).toBe(true);
    expect([await fee("stg_demand"), await fee("stg_ready")]).toEqual([4200, 0]);
    await setListingFee("stg_demand", null);
    expect(await fee("stg_demand")).toBeNull();
    expect(await setListingFee("stg_missing", 1)).toBe(false);
  });

  it("an unknown listing has no stage", async () => {
    expect(await stage("stg_missing")).toBeNull();
    expect(await deal("stg_missing")).toBeNull();
  });

  it("rejects the retired offer stages and accepts negotiating", async () => {
    await expect(pg.queryPg("insert into crm_bulk_offers (id, bulk_listing_id, role, stage) values ('stg_bad', 'stg_ready', 'counterparty', 'bid_in')")).rejects.toThrow();
    await pg.queryPg("insert into crm_bulk_offers (id, bulk_listing_id, role, stage) values ('stg_neg', 'stg_ready', 'counterparty', 'negotiating')");
    expect((await pg.queryPg<{ stage: string }>("select stage from crm_bulk_offers where id = 'stg_neg'"))[0].stage).toBe("negotiating");
    await pg.queryPg("delete from crm_bulk_offers where id = 'stg_neg'");
  });
});
