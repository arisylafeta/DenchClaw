import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Runs only against a disposable database: scripts/rebattery/crm-test-db.sh up prints the URL.
const TEST_URL = process.env.BULK_TRADES_TEST_DATABASE_URL;

describe.skipIf(!TEST_URL)("offer pairing (REB-565)", () => {
  let pg: typeof import("../postgres");
  let offers: typeof import("./bulk-offers");
  const run = Math.random().toString(36).slice(2, 8);
  const id = (s: string) => `${s}_${run}`;

  const listing = (lid: string, kind: "supply" | "demand", company: string | null, status = "open", reason: string | null = null, context: object = {}) =>
    pg.queryPg(
      `insert into crm_bulk_listings (id, kind, party, company_id, summary, status, closed_reason, spec, context) values ($1, $2, $3, $4, $3, $5, $6, $7, $8)`,
      [lid, kind, `Party ${lid}`, company, status, reason, JSON.stringify(kind === "demand" ? { intent: "request" } : {}), JSON.stringify(context)]);

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_URL;
    pg = await import("../postgres");
    offers = await import("./bulk-offers");
    for (const c of ["buyer1", "buyer2", "buyer3", "buyer4x", "buyer5x", "buyer6x"]) await pg.queryPg(`insert into crm_companies (id, name) values ($1, $1)`, [id(c)]);
    await listing(id("sup"), "supply", null);
    await listing(id("dem1"), "demand", id("buyer1"));                       // buyer1 has exactly one live demand
    await listing(id("dem2a"), "demand", id("buyer2"));                      // buyer2 has two
    await listing(id("dem2b"), "demand", id("buyer2"));
    await listing(id("dem3old"), "demand", id("buyer3"), "closed", "offer_reply"); // buyer3's only demand is an answered one
  });
  afterAll(async () => {
    await pg.queryPg(`delete from crm_bulk_listings where id like $1`, [`%_${run}`]);
    await pg.queryPg(`delete from crm_companies where id like $1`, [`%_${run}`]);
  });

  it("links automatically when the buyer has exactly one live demand, and shows the offer on both listings", async () => {
    const o = await offers.addOffer(id("sup"), { name: "Buyer 1", companyId: id("buyer1") });
    expect(o.counterpart_id).toBe(id("dem1"));
    const onDemand = await offers.listOffers(id("dem1"), null);
    expect(onDemand.map((x) => x.id)).toEqual([o.id]);
    expect(onDemand[0].incoming).toBe(true);
    expect(onDemand[0].from_kind).toBe("supply");
  });

  it("leaves the link empty and offers choices when the buyer has several live demands, or none live", async () => {
    const many = await offers.addOffer(id("sup"), { name: "Buyer 2", companyId: id("buyer2") });
    expect(many.counterpart_id).toBeNull();
    expect(many.link_options.map((l) => l.id).sort()).toEqual([id("dem2a"), id("dem2b")]);
    const none = await offers.addOffer(id("sup"), { name: "Buyer 3", companyId: id("buyer3") });
    expect(none.counterpart_id).toBeNull();
    expect(none.link_options).toEqual([]);
  });

  it("rejects a second offer for the same pairing, in either direction", async () => {
    await expect(offers.addOffer(id("sup"), { name: "Again", companyId: id("buyer1") })).rejects.toThrow(/already has an offer/);
    await expect(offers.addOffer(id("dem1"), { name: "Reverse", counterpartId: id("sup") })).rejects.toThrow(/already has an offer/);
    await expect(pg.queryPg(
      `insert into crm_bulk_offers (id, bulk_listing_id, role, name, counterpart_id) values ($1, $2, 'counterparty', 'x', $3)`,
      [id("bof_rev"), id("dem1"), id("sup")])).rejects.toThrow(/other direction/);
  });

  it("links a chosen listing later and refuses a closed or same-side target", async () => {
    const [many] = (await offers.listOffers(id("sup"), null)).filter((x) => x.name === "Buyer 2");
    await expect(offers.linkOffer(id("sup"), many.id, id("dem3old"), null)).rejects.toThrow(/live listing/);
    await expect(offers.linkOffer(id("sup"), many.id, id("sup"), null)).rejects.toThrow(/live listing/);
    const linked = await offers.linkOffer(id("sup"), many.id, id("dem2b"), null);
    expect(linked?.counterpart_id).toBe(id("dem2b"));
    expect(linked?.link_options).toEqual([]);
  });

  it("repoints offers when a demand is closed as a duplicate of a live one", async () => {
    await listing(id("dem4old"), "demand", id("buyer4x"));
    await listing(id("dem4new"), "demand", id("buyer4x"));
    const o = await offers.addOffer(id("sup"), { name: "Buyer 4", counterpartId: id("dem4old") });
    await pg.queryPg(
      `update crm_bulk_listings set context = context || jsonb_build_object('duplicate_of', $2::text), status = 'closed', closed_reason = 'duplicate' where id = $1`,
      [id("dem4old"), id("dem4new")]);
    const [row] = await pg.queryPg<{ counterpart_id: string; previous: string }>(
      `select counterpart_id, data->>'previous_counterpart_id' as previous from crm_bulk_offers where id = $1`, [o.id]);
    expect(row).toEqual({ counterpart_id: id("dem4new"), previous: id("dem4old") });
  });

  it("closing as offer_reply keeps the link, and the gap view skips it", async () => {
    await listing(id("dem5"), "demand", id("buyer5x"));
    const o = await offers.addOffer(id("sup"), { name: "Buyer 5", counterpartId: id("dem5") });
    await pg.queryPg(`update crm_bulk_listings set status = 'closed', closed_reason = 'offer_reply' where id = $1`, [id("dem5")]);
    const [row] = await pg.queryPg<{ counterpart_id: string }>(`select counterpart_id from crm_bulk_offers where id = $1`, [o.id]);
    expect(row.counterpart_id).toBe(id("dem5"));
    const gaps = await pg.queryPg<{ offer_id: string }>(`select offer_id from crm_bulk_offer_link_gaps where listing_id = $1`, [id("sup")]);
    expect(gaps.map((g) => g.offer_id)).not.toContain(o.id);
  });

  it("the gap view lists an unlinked offer whose buyer has a live demand", async () => {
    await listing(id("dem6"), "demand", id("buyer6x"));
    await pg.queryPg(`insert into crm_bulk_offers (id, bulk_listing_id, role, name, company_id) values ($1, $2, 'counterparty', 'B6', $3)`, [id("bof6"), id("sup"), id("buyer6x")]);
    const gaps = await pg.queryPg<{ offer_id: string; issue: string; candidates: string[] }>(`select offer_id, issue, candidates from crm_bulk_offer_link_gaps where listing_id = $1`, [id("sup")]);
    expect(gaps.find((g) => g.offer_id === id("bof6"))).toMatchObject({ issue: "unlinked", candidates: [id("dem6")] });
  });
});
