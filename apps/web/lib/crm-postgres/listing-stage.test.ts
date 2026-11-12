import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Runs only against a disposable database: scripts/rebattery/crm-test-db.sh up prints the URL.
const TEST_URL = process.env.BULK_TRADES_TEST_DATABASE_URL;

describe.skipIf(!TEST_URL)("bulk_listing_stage and bulk_listing_deal_stage (migrations 111 to 115)", () => {
  let pg: typeof import("../postgres");
  const stage = async (id: string) => (await pg.queryPg<{ s: string | null }>("select bulk_listing_stage($1) as s", [id]))[0].s;
  const deal = async (id: string) => (await pg.queryPg<{ s: string | null }>("select bulk_listing_deal_stage($1) as s", [id]))[0].s;
  // Paid and complete need the five paid facts (migration 111 refuses them otherwise): 40 packs, paid.
  const offer = (id: string, listing: string, st: string, counterpart: string | null = null) => pg.queryPg(
    `insert into crm_bulk_offers (id, bulk_listing_id, counterpart_id, role, stage, terms, quantity, paid_on, paid_amount, paid_currency, take_gbp)
     select $1, $2, $4, 'counterparty', $3, '{"unit": "pack"}'::jsonb, p.q, p.d, p.a, p.c, p.t
     from (select case when $3 in ('paid', 'complete') then 40 end as q, case when $3 in ('paid', 'complete') then date '2026-12-03' end as d,
             case when $3 in ('paid', 'complete') then 18000 end as a, case when $3 in ('paid', 'complete') then 'EUR' end as c,
             case when $3 in ('paid', 'complete') then 1500 end as t) p
     on conflict (id) do update set stage = excluded.stage, terms = excluded.terms, quantity = coalesce(excluded.quantity, crm_bulk_offers.quantity),
       paid_on = coalesce(excluded.paid_on, crm_bulk_offers.paid_on), paid_amount = coalesce(excluded.paid_amount, crm_bulk_offers.paid_amount),
       paid_currency = coalesce(excluded.paid_currency, crm_bulk_offers.paid_currency), take_gbp = coalesce(excluded.take_gbp, crm_bulk_offers.take_gbp)`,
    [id, listing, st, counterpart]);

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
        ('stg_demand', 'demand', 'Buyer', 'Packs', 'open', '10', 'Leeds', 'stg_company', '{"intent": "request", "product_family": "Ioniq"}'),
        ('stg_asked', 'demand', 'Buyer', 'Packs', 'qualifying', '10', null, 'stg_company', '{"intent": "request", "product_family": "Ioniq"}');
      insert into crm_bulk_listing_fields (bulk_listing_id, field_key, value, status, visibility) values
        ('stg_ready', 'soh', '92%', 'confirmed', 'never'), ('stg_ready', 'model', 'Kona 64 kWh', 'confirmed', 'teaser'),
        ('stg_partial', 'soh', null, 'missing', 'never'), ('stg_partial', 'model', 'Kona 64 kWh', 'confirmed', 'teaser');
      -- The Qualified rule of migration 112: each checklist item answered and checked by a person, then the tick.
      -- stg_partial is ticked and checked too, but its health is not answered, so it stays New.
      insert into crm_bulk_listing_fields (bulk_listing_id, field_key, value, status, visibility, checked_by, checked_at)
        select l, k, null, 'missing', 'never', 'alex@rebattery.io', now()
        from unnest(array['stg_ready', 'stg_partial']) l, unnest(array['model', 'quantity', 'location', 'soh']) k
        union all select 'stg_demand', k, null, 'missing', 'never', 'alex@rebattery.io', now() from unnest(array['product_family', 'quantity', 'location']) k
        on conflict (bulk_listing_id, field_key) do update set checked_by = excluded.checked_by, checked_at = excluded.checked_at;
      update crm_bulk_listings set qualified_at = now(), qualified_by = 'alex@rebattery.io' where id in ('stg_ready', 'stg_partial', 'stg_demand');
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

  it("keeps a qualified listing Qualified with an owner, and moves it on once a person starts a match run (migration 115)", async () => {
    const lastStage = async (id: string) => (await pg.queryPg<{ to_stage: string }>(
      "select to_stage from crm_bulk_stage_events where subject_kind = 'listing' and subject_id = $1 order by id desc limit 1", [id]))[0]?.to_stage;
    // Every new deal is owned by Alex from the start, so an owner moves nothing.
    await pg.queryPg(`update crm_bulk_listings set context = context || '{"owner": "Sean"}' where id in ('stg_demand', 'stg_ready', 'stg_partial')`);
    expect([await stage("stg_demand"), await stage("stg_ready"), await stage("stg_partial")]).toEqual(["Qualified", "Qualified", "New"]);
    // "A match run starts when a person marks the deal ready" (Alex, 12 Nov): runMatches keeps the last run in context.match_run.
    await pg.queryPg(`update crm_bulk_listings set context = context || '{"match_run": {"at": "2026-11-12T10:00:00Z", "by": "alex@rebattery.io", "count": 0}}'
      where id in ('stg_demand', 'stg_ready', 'stg_partial')`);
    expect([await stage("stg_demand"), await stage("stg_ready"), await stage("stg_partial")]).toEqual(["Sourcing", "Available", "New"]);
    // The stage events still fire on the write.
    expect([await lastStage("stg_demand"), await lastStage("stg_ready")]).toEqual(["Sourcing", "Available"]);
    await pg.queryPg(`update crm_bulk_listings set context = context - 'owner' - 'match_run' where id in ('stg_demand', 'stg_ready', 'stg_partial')`);
    expect(await stage("stg_demand")).toBe("Qualified");
    expect(await lastStage("stg_demand")).toBe("Qualified");
  });

  it("a supply with every item answered but no Qualified tick is New", async () => {
    await pg.queryPg("update crm_bulk_listings set qualified_at = null, qualified_by = null where id = 'stg_ready'");
    expect(await stage("stg_ready")).toBe("New");
    await pg.queryPg("update crm_bulk_listings set qualified_at = now(), qualified_by = 'alex@rebattery.io' where id = 'stg_ready'");
    expect(await stage("stg_ready")).toBe("Qualified");
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

  it("closes both listings when the offer is complete and sold all they state: supply as sold, demand as bought from us", async () => {
    await pg.queryPg("update crm_bulk_listings set quantity = '40 packs' where id in ('stg_ready', 'stg_demand')");
    await offer("stg_o1", "stg_ready", "complete", "stg_demand");
    const rows = await pg.queryPg<{ id: string; status: string; closed_reason: string }>(
      "select id, status, closed_reason from crm_bulk_listings where id in ('stg_ready', 'stg_demand') order by id");
    expect(rows).toEqual([{ id: "stg_demand", status: "closed", closed_reason: "bought_from_us" }, { id: "stg_ready", status: "closed", closed_reason: "sold" }]);
    expect([await stage("stg_ready"), await stage("stg_demand"), await deal("stg_ready")]).toEqual(["Sold", "Closed", "Delivered"]);
    await pg.queryPg("delete from crm_bulk_offers where id = 'stg_o1'");
    await pg.queryPg("update crm_bulk_listings set status = 'open', closed_reason = null, quantity = case kind when 'demand' then '10' else '40' end where id in ('stg_ready', 'stg_demand')");
  });

  const notes = async (id: string) => (await pg.queryPg<{ title: string }>(
    "select title from crm_bulk_listing_activity where bulk_listing_id = $1 and kind = 'status' and data ? 'offer_id' order by id", [id])).map((r) => r.title);

  it("leaves a listing open with a Part sold note when the offer sold less than it states", async () => {
    await pg.queryPg("update crm_bulk_listings set quantity = '100 packs' where id = 'stg_ready'");
    await pg.queryPg("update crm_bulk_listings set quantity = '40 packs' where id = 'stg_demand'");
    await offer("stg_o2", "stg_ready", "complete", "stg_demand");
    const rows = await pg.queryPg<{ id: string; status: string }>("select id, status from crm_bulk_listings where id in ('stg_ready', 'stg_demand') order by id");
    expect(rows).toEqual([{ id: "stg_demand", status: "closed" }, { id: "stg_ready", status: "open" }]);
    expect(await notes("stg_ready")).toEqual(["Part sold: 40 of 100"]);
    // Moving it back from Complete reopens nothing and says so on the closed listing.
    await offer("stg_o2", "stg_ready", "paid", "stg_demand");
    expect((await pg.queryPg<{ status: string }>("select status from crm_bulk_listings where id = 'stg_demand'"))[0].status).toBe("closed");
    expect(await notes("stg_demand")).toEqual(["Offer moved back from Complete: the listings stay closed"]);
    await pg.queryPg("delete from crm_bulk_offers where id = 'stg_o2'; delete from crm_bulk_listing_activity where bulk_listing_id in ('stg_ready', 'stg_demand') and data ? 'offer_id'");
    await pg.queryPg("update crm_bulk_listings set status = 'open', closed_reason = null, quantity = case kind when 'demand' then '10' else '40' end where id in ('stg_ready', 'stg_demand')");
  });

  it("leaves a listing open, to close by hand, when either quantity is unknown or in another unit", async () => {
    await pg.queryPg("update crm_bulk_listings set quantity = 'a container' where id = 'stg_ready'");
    await pg.queryPg("update crm_bulk_listings set quantity = '2,560 kWh' where id = 'stg_demand'");
    await offer("stg_o3", "stg_ready", "complete", "stg_demand");
    const rows = await pg.queryPg<{ status: string }>("select status from crm_bulk_listings where id in ('stg_ready', 'stg_demand')");
    expect(rows.map((r) => r.status)).toEqual(["open", "open"]);
    expect(await notes("stg_ready")).toEqual(["Offer complete: close this listing by hand if all of it is sold"]);
    expect(await notes("stg_demand")).toEqual(["Offer complete: close this listing by hand if all of it is sold"]);
    await pg.queryPg("delete from crm_bulk_offers where id = 'stg_o3'; delete from crm_bulk_listing_activity where bulk_listing_id in ('stg_ready', 'stg_demand') and data ? 'offer_id'");
    await pg.queryPg("update crm_bulk_listings set quantity = case kind when 'demand' then '10' else '40' end where id in ('stg_ready', 'stg_demand')");
  });

  it("refuses paid or complete without the five paid facts from any writer, plain SQL included, and closes nothing", async () => {
    await expect(pg.queryPg("insert into crm_bulk_offers (id, bulk_listing_id, counterpart_id, role, stage) values ('stg_raw', 'stg_ready', 'stg_demand', 'counterparty', 'complete')"))
      .rejects.toThrow("To mark this offer Complete, add the paid date, amount paid, currency, quantity and take in GBP.");
    await pg.queryPg("insert into crm_bulk_offers (id, bulk_listing_id, role, stage) values ('stg_raw', 'stg_ready', 'counterparty', 'invoiced')");
    await expect(pg.queryPg("update crm_bulk_offers set stage = 'paid', paid_on = '2026-12-03', quantity = 4 where id = 'stg_raw'"))
      .rejects.toThrow("To mark this offer Paid, add the amount paid, currency and take in GBP.");
    await pg.queryPg("update crm_bulk_offers set stage = 'paid', paid_on = '2026-12-03', paid_amount = 1, paid_currency = 'GBP', quantity = 4, take_gbp = 1 where id = 'stg_raw'");
    await expect(pg.queryPg("update crm_bulk_offers set take_gbp = null where id = 'stg_raw'")).rejects.toThrow(/take in GBP/);
    expect((await pg.queryPg<{ status: string }>("select status from crm_bulk_listings where id = 'stg_ready'"))[0].status).toBe("open");
    await pg.queryPg("delete from crm_bulk_offers where id = 'stg_raw'");
  });

  it("holds a listing Reserved through today's London date (bulk_today)", async () => {
    expect((await pg.queryPg<{ ok: boolean }>("select bulk_today() = (now() at time zone 'Europe/London')::date as ok"))[0].ok).toBe(true);
    await pg.queryPg("update crm_bulk_listings set hold_until = bulk_today() where id = 'stg_ready'");
    expect(await stage("stg_ready")).toBe("Reserved");
    await pg.queryPg("update crm_bulk_listings set hold_until = null where id = 'stg_ready'");
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
