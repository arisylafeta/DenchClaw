import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MatchesResult, MatchRow } from "../matches-types";

// Reservations and yeses on a disposable database (scripts/rebattery/crm-test-db.sh up prints the URL): how long a
// reservation holds once the deal moves on, what it counts in, and a yes that makes and links its offer in one go.
// The scorer and the model are stand-ins; nothing here sends mail or calls a model.
const TEST_URL = process.env.BULK_TRADES_TEST_DATABASE_URL;

describe.skipIf(!TEST_URL)("reservations and yeses (migration 113)", () => {
  let pg: typeof import("../postgres");
  let matches: typeof import("./bulk-matches");
  let mail: typeof import("./bulk-offer-mail");
  const run = Math.random().toString(36).slice(2, 8);
  const id = (s: string) => `rsv_${s}_${run}`;
  const actor = { userId: null, email: "alex@rebattery.io" };
  const yesterday = "now()::date - 1";

  /** A supply lot of 24 packs, a request for it, and the request's offer on the lot with a confirmed match behind it. */
  const deal = async (n: string, offer: { unit: string; quantity: number | null }, match: { confirmed?: number | null; kwh?: number | null } = {}) => {
    await pg.queryPg(
      `insert into crm_bulk_listings (id, kind, party, summary, quantity, status, spec) values
         ($1, 'supply', 'Seller', 'Kona lot', '24 packs', 'open', '{}'),
         ($2, 'demand', 'Buyer', 'Kona packs', '10 packs', 'open', '{"intent": "request"}')
       on conflict (id) do nothing`, [id(`sup${n}`), id(`dem${n}`)]);
    await pg.queryPg(
      `insert into crm_bulk_offers (id, bulk_listing_id, counterpart_id, role, name, stage, terms, quantity)
       values ($1, $2, $3, 'counterparty', 'Buyer', 'candidate', $4::jsonb, $5)`,
      [id(`of${n}`), id(`sup${n}`), id(`dem${n}`), JSON.stringify({ amount: 100, currency: "GBP", unit: offer.unit }), offer.quantity]);
    await pg.queryPg(
      `insert into crm_bulk_matches (id, deal_id, candidate_kind, candidate_id, candidate_key, name, stock_kind, stock_id, candidate_qty,
         state, verdict, verdict_at, confirmed_qty, offer_id, data)
       values ($1, $2, 'listing', $3, $4, 'Buyer', 'listing', $5, 24, 'confirmed', 'yes', now(), $6, $7, $8::jsonb)`,
      [id(`m${n}`), id(`sup${n}`), id(`dem${n}`), `demand:${id(`dem${n}`)}`, id("sup1"), match.confirmed ?? null, id(`of${n}`),
        JSON.stringify(match.kwh != null ? { kwh_per_unit: match.kwh } : {})]);
  };
  const stage = async (listing: string) => (await pg.queryPg<{ s: string }>("select bulk_listing_stage($1) as s", [listing]))[0].s;
  const matchOf = async (n: string) => (await pg.queryPg<{ state: string; reserved_qty: number | null; reserved_until: string | null; note: string | null; refused: string | null }>(
    `select state, reserved_qty::float8 as reserved_qty, reserved_until::text as reserved_until, note, data->>'reservation_refused' as refused
     from crm_bulk_matches where id = $1`, [id(`m${n}`)]))[0];
  const setStage = (n: string, st: string) => pg.queryPg("update crm_bulk_offers set stage = $2 where id = $1", [id(`of${n}`), st]);

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_URL;
    pg = await import("../postgres");
    matches = await import("./bulk-matches");
    mail = await import("./bulk-offer-mail");
  });
  afterAll(async () => {
    await pg.queryPg("delete from crm_bulk_matches where deal_id like $1", [`rsv_%_${run}`]);
    await pg.queryPg("delete from crm_bulk_offers where bulk_listing_id like $1", [`rsv_%_${run}`]);
    await pg.queryPg("delete from crm_bulk_listing_activity where bulk_listing_id like $1", [`rsv_%_${run}`]);
    await pg.queryPg("delete from crm_bulk_listings where id like $1", [`rsv_%_${run}`]);
    await pg.queryPg("delete from crm_stock_opportunities where id like $1", [`rsv_%_${run}`]);
    await pg.queryPg("delete from crm_people where id like $1", [`rsv_%_${run}`]);
    await pg.queryPg("delete from crm_companies where id like $1", [`rsv_%_${run}`]);
    await pg.pgPool.end();
  });

  it("holds a reservation past its date once the offer is negotiating, and the daily expiry leaves it alone", async () => {
    await deal("1", { unit: "pack", quantity: null }, { confirmed: 10 });
    await setStage("1", "offered");
    expect(await matchOf("1")).toMatchObject({ state: "offered", reserved_qty: 10 });
    expect(await stage(id("sup1"))).toBe("Reserved");
    // At offered, the date rules: a lapsed reservation reads as free.
    await pg.queryPg(`update crm_bulk_matches set reserved_until = ${yesterday} where id = $1`, [id("m1")]);
    expect(await stage(id("sup1"))).not.toBe("Reserved");
    // Negotiating: live until the offer ends, whatever the date.
    await setStage("1", "negotiating");
    expect(await stage(id("sup1"))).toBe("Reserved");
    expect(await matches.listingReservations(id("sup1"))).toMatchObject({ holds: 1, qty: 10, whileLive: true });
    expect(await matches.expireMatches()).toBe(0);
    expect((await matchOf("1")).state).toBe("offered");
    const listed = await matches.listStoredMatches(id("sup1"));
    const view = [...listed.matches, ...listed.past].find((row) => row.id === id("m1"));
    expect(view).toMatchObject({ reservation_live: true, offer_stage: "negotiating" });
    // Complete has consumed it: not live, and not expired either.
    await pg.queryPg("update crm_bulk_offers set stage = 'complete', paid_on = now()::date, paid_amount = 1000, paid_currency = 'GBP', quantity = 10, take_gbp = 100 where id = $1", [id("of1")]);
    expect((await matches.listingReservations(id("sup1"))).holds).toBe(0);
    expect(await matches.expireMatches()).toBe(0);
    expect((await matchOf("1")).state).toBe("offered");
  });

  it("counts a per-kWh offer in units by the lot's kWh per unit", async () => {
    await deal("2", { unit: "kWh", quantity: 640 }, { kwh: 64 });
    await setStage("2", "offered");
    expect(await matchOf("2")).toMatchObject({ state: "offered", reserved_qty: 10, refused: null });
    await setStage("2", "lost");
  });

  it("holds the whole lot when the quantity cannot be counted in units, and says so when that is refused", async () => {
    await deal("3", { unit: "kWh", quantity: 640 });
    await setStage("3", "offered");
    expect(await matchOf("3")).toMatchObject({ state: "offered", reserved_qty: null });
    expect((await matchOf("3")).reserved_until).not.toBeNull();
    expect(await matches.listingReservations(id("sup1"))).toMatchObject({ holds: 1, whole: 1 });
    // A second deal on the same lot: refused, kept on the match, and told to the person who sends.
    await deal("4", { unit: "kg", quantity: 5 });
    const sent = await mail.markOfferSent(id("of4"), null);
    expect(sent).toMatchObject({ moved: true, stage: "offered" });
    expect(sent?.reservation).toMatch(/whole lot/);
    expect(await matchOf("4")).toMatchObject({ state: "offered", reserved_qty: null, reserved_until: null, refused: expect.stringMatching(/whole lot/) });
    await setStage("3", "lost");
    await setStage("4", "lost");
  });

  it("stores the lot's kWh per unit on a run, so a per-kWh offer can be counted later", async () => {
    await pg.queryPg(
      `insert into crm_bulk_listings (id, kind, party, summary, quantity, location, status, spec) values
         ($1, 'supply', 'Seller', 'Kona lot', '24 packs', 'Leeds, UK', 'open', '{}'),
         ($2, 'demand', 'Buyer', 'Kona packs', '10 packs', 'Leeds, UK', 'open', '{"intent": "request"}')`, [id("lot"), id("req")]);
    for (const [key, value] of [["model", "Hyundai Kona pack"], ["capacity", "64 kWh per pack"], ["format", "Packs"], ["chemistry", "NMC"]]) {
      await pg.queryPg(`insert into crm_bulk_listing_fields (bulk_listing_id, field_key, value, status, visibility) values ($1, $2, $3, 'confirmed', 'teaser')`, [id("lot"), key, value]);
    }
    const row: MatchRow = {
      key: `supply:${id("lot")}`, rank: 1, name: "Seller", detail: null, tags: ["our listing"], reason: "Model matches", checks: [], price: null,
      offer: null, companyId: null, personId: null, contact: null, stockId: null, units: 24,
    };
    const scorer = async (d: { id: string }): Promise<MatchesResult> => ({
      id: d.id, kind: "demand", lotKey: { line: "Kona packs", full: [], open: false }, rows: [row], considered: 1, blocked: null, errors: [],
    });
    await matches.runMatches(id("req"), actor, { scorer, ranker: null });
    const [stored] = await pg.queryPg<{ kwh: string | null }>("select data->>'kwh_per_unit' as kwh from crm_bulk_matches where deal_id = $1", [id("req")]);
    expect(Number(stored.kwh)).toBe(64);
  });

  it("makes and links a yes's offer in one go: a second match for the same counterparty is a plain 409, and no stray offer is left", async () => {
    await pg.queryPg("insert into crm_companies (id, name) values ($1, 'Twin Supplier')", [id("co")]);
    await pg.queryPg("insert into crm_people (id, full_name, email, company_id) values ($1, 'Pat Twin', $2, $3)", [id("pe"), `pat.${run}@twin.test`, id("co")]);
    await pg.queryPg(`insert into crm_bulk_listings (id, kind, party, summary, quantity, location, status, spec)
      values ($1, 'demand', 'Buyer', 'Kona packs', '10 packs', 'Leeds, UK', 'open', '{"intent": "request"}')`, [id("twin")]);
    for (const n of ["a", "b"]) {
      await pg.queryPg(`insert into crm_stock_opportunities (id, person_id, company_id, status, title, quantity, details) values ($1, $2, $3, 'opportunity', 'Kona pack', 10, '{}')`,
        [id(`st${n}`), id("pe"), id("co")]);
      await pg.queryPg(
        `insert into crm_bulk_matches (id, deal_id, candidate_kind, candidate_id, candidate_key, name, company_id, person_id, contact, stock_kind, stock_id, candidate_qty, rank, state)
         values ($1, $2, 'stock', $3, $4, 'Twin Supplier', $5, $6, $7, 'stock', $3, 10, $8, 'proposed')`,
        [id(`tm${n}`), id("twin"), id(`st${n}`), `stock:${id(`st${n}`)}`, id("co"), id("pe"), `pat.${run}@twin.test`, n === "a" ? 1 : 2]);
    }
    const until = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    // A yes that fails after its offer was made (here its History line names a user who does not exist) leaves no offer.
    await expect(matches.matchYes(id("twin"), id("tma"), { validUntil: until }, { userId: "7d0e5d38-5b6f-4a37-9d77-00000000dead", email: "ghost@rebattery.io" }))
      .rejects.toThrow();
    expect(await pg.queryPg("select id from crm_bulk_offers where bulk_listing_id = $1", [id("twin")])).toEqual([]);
    expect((await pg.queryPg<{ offer_id: string | null; state: string }>("select offer_id, state from crm_bulk_matches where id = $1", [id("tma")]))[0])
      .toEqual({ offer_id: null, state: "proposed" });
    const results = await Promise.allSettled(["a", "b"].map((n) => matches.matchYes(id("twin"), id(`tm${n}`), { validUntil: until }, actor)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r): r is PromiseRejectedResult => r.status === "rejected")!.reason as { status?: number; message: string };
    expect(refused).toMatchObject({ status: 409, message: "This counterparty already has an offer on this deal from another match." });
    const offers = await pg.queryPg<{ id: string }>("select id from crm_bulk_offers where bulk_listing_id = $1", [id("twin")]);
    expect(offers).toHaveLength(1);
    const linked = await pg.queryPg<{ offer_id: string | null }>("select offer_id from crm_bulk_matches where deal_id = $1 and offer_id is not null", [id("twin")]);
    expect(linked.map((r) => r.offer_id)).toEqual([offers[0].id]);
  });
});
