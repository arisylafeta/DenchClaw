import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Runs only against a disposable database: scripts/rebattery/crm-test-db.sh up prints the URL.
const TEST_URL = process.env.BULK_TRADES_TEST_DATABASE_URL;

describe.skipIf(!TEST_URL)("commercial-buyer stock (REB-577)", () => {
  let pg: typeof import("../postgres");
  let stock: typeof import("./commercial-stock");
  const run = Math.random().toString(36).slice(2, 8);
  const id = (s: string) => `${s}_${run}`;

  const item = (sid: string, company: string, person: string, status: string, details: object, quantity: number | null = null) =>
    pg.queryPg(
      `insert into crm_stock_opportunities (id, person_id, company_id, status, title, quantity, marketplace_listing_id, details)
       values ($1, $2, $3, $4, $1, $5, $6, $7)`,
      [id(sid), id(person), id(company), status, quantity, status === "listed" ? id(`mkt_${sid}`) : null, JSON.stringify(details)]);

  const pack = { make: "Peugeot", model: "208", format: "pack", capacity_kwh: 50, chemistry: "NMC", sync_class: "synced", price_eur_ex_vat: 4000 };

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_URL;
    pg = await import("../postgres");
    stock = await import("./commercial-stock");
    for (const c of ["breaker_a", "breaker_b"]) await pg.queryPg("insert into crm_companies (id, name, country) values ($1, $1, 'Sweden')", [id(c)]);
    for (const [p, c] of [["pa", "breaker_a"], ["pb", "breaker_b"]]) await pg.queryPg("insert into crm_people (id, full_name, company_id) values ($1, $1, $2)", [id(p), id(c)]);
    await item("live_a", "breaker_a", "pa", "opportunity", pack);
    await item("live_b", "breaker_b", "pb", "listed", { ...pack, price_eur_ex_vat: 3500, sync_class: "marketplace" });
    await item("stale", "breaker_a", "pa", "stale", pack);
    await item("nodeliver", "breaker_a", "pa", "opportunity", { ...pack, deliver: false });
    await item("sold", "breaker_b", "pb", "opportunity", { ...pack, availability: { state: "sold" } });
    await item("gone", "breaker_b", "pb", "opportunity", { ...pack, sync: { available: false } });
  });
  afterAll(async () => {
    await pg.queryPg("delete from crm_stock_opportunities where id like $1", [`%_${run}`]);
    await pg.queryPg("delete from crm_people where id like $1", [`%_${run}`]);
    await pg.queryPg("delete from crm_companies where id like $1", [`%_${run}`]);
  });

  const mine = async () => (await stock.liveStock()).filter((row) => row.id.endsWith(`_${run}`));

  it("loads only deliverable live stock", async () => {
    const rows = await mine();
    expect(rows.map((row) => row.id).sort()).toEqual([id("live_a"), id("live_b")]);
    expect(rows[0]).toMatchObject({ capacity_kwh: 50, country: "Sweden", quantity: 1 });
  });
});
