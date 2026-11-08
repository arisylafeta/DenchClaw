import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Runs only against a disposable database: scripts/rebattery/crm-test-db.sh up prints the URL.
const TEST_URL = process.env.BULK_TRADES_TEST_DATABASE_URL;

/**
 * Add to offers must not create a second offer for the same counterparty on one listing, whether or not the offer is
 * linked to an opposite listing. The linked case keeps its 409; the unlinked case returns the existing offer.
 */
describe.skipIf(!TEST_URL)("addOffer duplicate guard", () => {
  let pg: typeof import("../postgres");
  let offers: typeof import("./bulk-offers");
  const run = Math.random().toString(36).slice(2, 8);
  const id = (s: string) => `dup_${s}_${run}`;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_URL;
    pg = await import("../postgres");
    offers = await import("./bulk-offers");
    await pg.queryPg(
      `insert into crm_companies (id, name) values ($1, 'Synthetic Duplicate Co'), ($2, 'Synthetic Other Co')`,
      [id("co"), id("other")]);
    await pg.queryPg(`insert into crm_people (id, company_id, full_name, email) values ($1, $2, 'Synthetic Buyer', 'buyer@synthetic.test')`,
      [id("pe"), id("co")]);
    // A live supply listing, and a demand listing used for the linked pairing. Neither company has an open demand,
    // so nothing is auto-linked and the unlinked path is the one exercised.
    await pg.queryPg(
      `insert into crm_bulk_listings (id, kind, party, summary, status, spec) values
         ($1, 'supply', 'Synthetic Duplicate Co', 'Synthetic lot', 'open', '{}'),
         ($2, 'demand', 'Synthetic Duplicate Co', 'Synthetic ask', 'open', '{"intent": "request"}')`,
      [id("sup"), id("dem")]);
  });

  afterAll(async () => {
    if (!pg) return;
    await pg.queryPg(`delete from crm_bulk_offers where bulk_listing_id like $1`, [`dup_%_${run}`]);
    await pg.queryPg(`delete from crm_bulk_listings where id like $1`, [`dup_%_${run}`]);
    await pg.queryPg(`delete from crm_people where id like $1`, [`dup_%_${run}`]);
    await pg.queryPg(`delete from crm_companies where id like $1`, [`dup_%_${run}`]);
    await pg.pgPool.end();
  });

  const countOffers = async (listingId: string, where: string, params: unknown[] = []) =>
    (await pg.queryPg<{ n: string }>(`select count(*)::text as n from crm_bulk_offers where bulk_listing_id = $1 and ${where}`, [listingId, ...params]))[0].n;

  it("returns the same offer for a company click twice and stores data.match once", async () => {
    const first = await offers.addOffer(id("sup"), {
      name: "Synthetic Duplicate Co", companyId: id("co"), personId: id("pe"), contact: "buyer@synthetic.test",
      data: { match: { reason: "Exact part: 50 kWh Packs NMC", rank: 1, at: "2026-11-08T10:00:00.000Z" } },
    });
    const second = await offers.addOffer(id("sup"), { name: "Synthetic Duplicate Co", companyId: id("co"), personId: id("pe") });
    expect(second.id).toBe(first.id);
    expect(first.stage).toBe("candidate");
    expect(await countOffers(id("sup"), `role = 'counterparty' and counterpart_id is null`)).toBe("1");
    const [stored] = await pg.queryPg<{ match: { rank: number } }>(`select data->'match' as match from crm_bulk_offers where id = $1`, [first.id]);
    expect(stored.match).toMatchObject({ rank: 1 });
  });

  it("treats two contacts at one company as one counterparty", async () => {
    await pg.queryPg(`insert into crm_people (id, company_id, full_name) values ($1, $2, 'Synthetic Colleague')`, [id("pe2"), id("co")]);
    const withOtherContact = await offers.addOffer(id("sup"), { name: "Synthetic Duplicate Co", companyId: id("co"), personId: id("pe2") });
    expect(await countOffers(id("sup"), `role = 'counterparty' and counterpart_id is null`)).toBe("1");
    expect(withOtherContact.person_id).toBe(id("pe"));
  });

  it("returns the same offer for the same person when no company is known", async () => {
    await pg.queryPg(`insert into crm_people (id, company_id, full_name) values ($1, null, 'Unattached Seller')`, [id("pe3")]);
    const first = await offers.addOffer(id("sup"), { name: "Unattached Seller", personId: id("pe3") });
    const second = await offers.addOffer(id("sup"), { name: "Unattached Seller", personId: id("pe3") });
    expect(second.id).toBe(first.id);
    expect(await countOffers(id("sup"), `person_id = $2`, [id("pe3")])).toBe("1");
  });

  it("returns the same offer for the same written name when there is no CRM identity", async () => {
    const first = await offers.addOffer(id("sup"), { name: "Marketplace Seller Ltd" });
    const second = await offers.addOffer(id("sup"), { name: "marketplace seller ltd" });
    expect(second.id).toBe(first.id);
    expect(await countOffers(id("sup"), `company_id is null and person_id is null`)).toBe("1");
  });

  it("still creates a separate offer for a different counterparty", async () => {
    await pg.queryPg(`insert into crm_companies (id, name) values ($1, 'Synthetic Other Co') on conflict do nothing`, [id("other")]);
    const other = await offers.addOffer(id("sup"), { name: "Synthetic Other Co", companyId: id("other") });
    expect(await countOffers(id("sup"), `company_id = $2`, [id("other")])).toBe("1");
    expect(other.id).not.toBe((await offers.listOffers(id("sup"), null)).find((o) => o.company_id === id("co"))?.id);
  });

  it("keeps the linked pairing a conflict and names the offer that exists", async () => {
    const linked = await offers.addOffer(id("sup"), { name: "Linked Buyer", companyId: id("other"), counterpartId: id("dem") });
    expect(linked.counterpart_id).toBe(id("dem"));
    await expect(offers.addOffer(id("sup"), { name: "Linked Buyer", companyId: id("other"), counterpartId: id("dem") }))
      .rejects.toMatchObject({ name: "OfferConflict", message: expect.stringMatching(/already has an offer/), existingOfferId: linked.id });
    const [again] = await offers.listOffers(id("sup"), null);
    expect(again.counterpart_id).toBe(id("dem"));
  });

  // Two clicks that both pass the pre-check race on the unique index. The loser must come back as the same named
  // conflict the pre-check gives, never as a raw duplicate-key error.
  it("resolves a lost race on the same pairing without a raw 23505", async () => {
    await pg.queryPg(`insert into crm_companies (id, name) values ($1, 'Synthetic Race Co')`, [id("race")]);
    await pg.queryPg(
      `insert into crm_bulk_listings (id, kind, party, summary, status, spec) values ($1, 'demand', 'Synthetic Race Co', 'Synthetic ask', 'open', '{"intent": "request"}')`,
      [id("dem2")]);
    const results = await Promise.allSettled([
      offers.addOffer(id("sup"), { name: "Synthetic Race Co", companyId: id("race"), counterpartId: id("dem2") }),
      offers.addOffer(id("sup"), { name: "Synthetic Race Co", companyId: id("race"), counterpartId: id("dem2") }),
    ]);
    const won = results.filter((result) => result.status === "fulfilled");
    const lost = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0].reason).toBeInstanceOf(offers.OfferConflict);
    expect(lost[0].reason.message).toMatch(/already has an offer/);
    expect(lost[0].reason.message).not.toMatch(/23505|duplicate key/);
    expect(await countOffers(id("sup"), `counterpart_id = $2`, [id("dem2")])).toBe("1");
  });

  it("the migration's index refuses a raw duplicate counterparty row", async () => {
    await expect(pg.queryPg(
      `insert into crm_bulk_offers (id, bulk_listing_id, role, company_id, name) values ($1, $2, 'counterparty', $3, 'Raw duplicate')`,
      [id("bof_raw"), id("sup"), id("co")])).rejects.toThrow(/crm_bulk_offers_counterparty_uidx|duplicate key/);
  });
});
