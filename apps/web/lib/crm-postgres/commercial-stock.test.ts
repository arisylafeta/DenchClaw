import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Runs only against a disposable database: scripts/rebattery/crm-test-db.sh up prints the URL.
const TEST_URL = process.env.BULK_TRADES_TEST_DATABASE_URL;

describe.skipIf(!TEST_URL)("commercial-buyer stock and buy requests (REB-577)", () => {
  let pg: typeof import("../postgres");
  let stock: typeof import("./commercial-stock");
  let pure: typeof import("../commercial-stock");
  const run = Math.random().toString(36).slice(2, 8);
  const id = (s: string) => `${s}_${run}`;
  const requestId = crypto.randomUUID();
  const email = `buyer-${run}@example.test`;

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
    pure = await import("../commercial-stock");
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
    const listings = await pg.queryPg<{ id: string }>("select id from crm_bulk_listings where source_id = $1", [`sourcing_request:${requestId}`]);
    for (const { id: lid } of listings) await pg.queryPg("delete from crm_bulk_listings where id = $1", [lid]);
    await pg.queryPg("delete from crm_stock_opportunities where id like $1", [`%_${run}`]);
    await pg.queryPg("delete from crm_people where id like $1 or lower(email) = $2", [`%_${run}`, email]);
    await pg.queryPg("delete from crm_companies where id like $1", [`%_${run}`]);
  });

  const mine = async () => (await stock.liveStock()).filter((row) => row.id.endsWith(`_${run}`));

  it("loads only deliverable live stock", async () => {
    const rows = await mine();
    expect(rows.map((row) => row.id).sort()).toEqual([id("live_a"), id("live_b")]);
    expect(rows[0]).toMatchObject({ capacity_kwh: 50, country: "Sweden", quantity: 1 });
  });

  it("creates one demand with a candidate offer per supplier, idempotently", async () => {
    const rows = await mine();
    const groupKey = pure.groupKeyFor(rows[0]);
    const input = { sourcingRequestId: requestId, conversationId: null, email, wants: "Two Peugeot 208 packs", country: "FR", neededBy: null, timing: "this month",
      lines: [{ groupKey, quantity: 3, targetPriceEur: 3800 }] };
    const first = await stock.createBuyRequest(input, rows);
    expect(first).toMatchObject({ created: true, suppliers: 2, offersAdded: 2, lines: [{ groupKey, wanted: 3, allocated: 2 }] });

    const [listing] = await pg.queryPg<{ kind: string; status: string; source_kind: string; spec: Record<string, unknown>; person_id: string }>(
      "select kind, status, source_kind, spec, person_id from crm_bulk_listings where id = $1", [first.listingId]);
    expect(listing).toMatchObject({ kind: "demand", status: "open", source_kind: "jules" });
    expect(listing.spec).toMatchObject({ intent: "request", volume: 3, volume_unit: "packs", max_price: 3800, price_unit: "pack", commercial_buyer: true });
    const [buyer] = await pg.queryPg<{ email: string; tags: string[] }>("select email, tags from crm_people where id = $1", [listing.person_id]);
    expect(buyer).toMatchObject({ email, tags: ["commercial-buyer"] });

    const offers = await pg.queryPg<{ company_id: string; stage: string; data: { stock: { stock_id: string }[] } }>(
      "select company_id, stage, data from crm_bulk_offers where bulk_listing_id = $1 order by company_id", [first.listingId]);
    expect(offers.map((o) => [o.company_id, o.stage, o.data.stock.map((s) => s.stock_id)])).toEqual([
      [id("breaker_a"), "candidate", [id("live_a")]], [id("breaker_b"), "candidate", [id("live_b")]]]);
    const [{ stage }] = await pg.queryPg<{ stage: string }>("select bulk_listing_stage($1) as stage", [first.listingId]);
    expect(stage).toBe("Found");

    const again = await stock.createBuyRequest(input, rows);
    expect(again).toMatchObject({ listingId: first.listingId, created: false, offersAdded: 0 });
    const [{ count }] = await pg.queryPg<{ count: number }>("select count(*)::int as count from crm_bulk_offers where bulk_listing_id = $1", [first.listingId]);
    expect(count).toBe(2);
  });

  it("follows an edited request: updates the demand, keeps changed suppliers and drops unneeded candidates", async () => {
    const rows = await mine();
    const groupKey = pure.groupKeyFor(rows[0]);
    const input = { sourcingRequestId: requestId, conversationId: null, email, wants: "One Peugeot 208 pack", country: "FR", neededBy: null, timing: null,
      lines: [{ groupKey, quantity: 1 }] };
    const edited = await stock.createBuyRequest(input, rows);
    expect(edited).toMatchObject({ created: false, offersAdded: 0, lines: [{ wanted: 1, allocated: 1 }] });
    const [listing] = await pg.queryPg<{ summary: string; spec: Record<string, unknown> }>("select summary, spec from crm_bulk_listings where id = $1", [edited.listingId]);
    expect(listing.summary).toBe("One Peugeot 208 pack");
    expect(listing.spec).toMatchObject({ volume: 1 });
    expect(listing.spec).not.toHaveProperty("max_price");
    const offers = await pg.queryPg<{ company_id: string; stage: string }>(
      "select company_id, stage from crm_bulk_offers where bulk_listing_id = $1 order by company_id", [edited.listingId]);
    expect(offers.map((o) => [o.company_id, o.stage])).toEqual([[id("breaker_a"), "candidate"], [id("breaker_b"), "declined"]]);
  });

  it("attaches stock to a demand the daily importer created first", async () => {
    const otherRequest = crypto.randomUUID();
    const importedId = id("btd_imported");
    await pg.queryPg(
      `insert into crm_bulk_listings (id, kind, party, email, summary, status, source_kind, source_id, spec)
       values ($1, 'demand', $2, $2, 'Peugeot packs', 'qualifying', 'jules', $3, '{"intent": "request"}')`, [importedId, email, `sourcing_request:${otherRequest}`]);
    try {
      const rows = await mine();
      const result = await stock.createBuyRequest({ sourcingRequestId: otherRequest, conversationId: null, email, wants: "Peugeot packs", country: null,
        neededBy: null, timing: null, lines: [{ groupKey: pure.groupKeyFor(rows[0]), quantity: 2 }] }, rows);
      expect(result).toMatchObject({ listingId: importedId, created: false, offersAdded: 2 });
    } finally {
      await pg.queryPg("delete from crm_bulk_listings where id = $1", [importedId]);
    }
  });
});
