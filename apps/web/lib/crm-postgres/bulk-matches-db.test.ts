import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MatchesResult, MatchRow } from "../matches-types";
import type { MatchRanker } from "../match/match-ranker";

// Runs only against a disposable database: scripts/rebattery/crm-test-db.sh up prints the URL. The scorer, the model and
// the mail CLI are stand-ins, so nothing here reads live stock, calls a model or makes a real draft.
const TEST_URL = process.env.BULK_TRADES_TEST_DATABASE_URL;

describe.skipIf(!TEST_URL)("stored matching (migration 113)", () => {
  let pg: typeof import("../postgres");
  let matches: typeof import("./bulk-matches");
  let offers: typeof import("./bulk-offers");
  let events: typeof import("./bulk-stage-events");
  const run = Math.random().toString(36).slice(2, 8);
  const id = (s: string) => `${s}_${run}`;
  const user = "7d0e5d38-5b6f-4a37-9d77-000000000113";
  const email = `alex+${run}@rebattery.io`;
  const actor = { userId: user, email };
  const drafts: { to: string[]; subject: string; body: string }[] = [];
  const draft = async (input: { to: string[]; subject: string; body: string }) => { drafts.push(input); return `draft_${drafts.length}_${run}`; };
  const silent: MatchRanker | null = null;
  const yesterday = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

  const supplier = (n: number, o: Partial<MatchRow> = {}): MatchRow => ({
    key: `stock:${id(`st${n}`)}`, rank: n, name: `Supplier ${n}`, detail: null, tags: ["unlisted stock"],
    reason: `Model matches: Kona (${n})`, checks: [], price: null, offer: null, companyId: id(`co${n}`), personId: id(`pe${n}`),
    contact: `s${n}.${run}@supplier.test`, stockId: id(`st${n}`), units: 30, country: "United Kingdom", holds: "Hyundai Kona 64 kWh pack",
    fit: [{ key: "model", label: "Hyundai Kona", state: "fits" }], ...o,
  });
  const result = (dealId: string, rows: MatchRow[], o: Partial<MatchesResult> = {}): MatchesResult => ({
    id: dealId, kind: "demand", lotKey: { line: "Hyundai Kona 64 kWh packs", full: [], open: false }, rows, considered: rows.length,
    blocked: null, errors: [], ...o,
  });
  // The scorer's list for every request in this test: three that must be excluded, then eight good ones.
  const demandRows = () => [
    supplier(90, { key: `supply:${id("sclosed")}`, stockId: null, companyId: id("co90") }),
    supplier(91, { key: `trade:${id("scontract")}`, stockId: null }),
    supplier(92),
    supplier(1, { key: `supply:${id("s1")}`, stockId: null, units: 24 }),
    supplier(2), supplier(3, { units: null }), supplier(4), supplier(5), supplier(6), supplier(7), supplier(8),
  ];
  const scorer = async (deal: { id: string }) => result(deal.id, demandRows());
  const deps = (o: Record<string, unknown> = {}) => ({ scorer, ranker: silent, draft, ...o });
  const stageOf = async (listingId: string) =>
    (await pg.queryPg<{ stage: string }>("select bulk_listing_stage($1) as stage", [listingId]))[0].stage;
  const lastEvent = async (listingId: string) => (await events.listStageEvents("listing", listingId)).at(-1);
  /** Checks a demand's what, how many and where, then ticks it Qualified, as a person does on the checklist. */
  const qualify = async (listingId: string) => {
    await pg.queryPg(
      `insert into crm_bulk_listing_fields (bulk_listing_id, field_key, value, status, visibility, checked_by, checked_at)
       select $1, k, null, 'missing', 'never', $2, now() from unnest(array['product_family', 'quantity', 'location']) k
       on conflict (bulk_listing_id, field_key) do update set checked_by = excluded.checked_by, checked_at = excluded.checked_at`, [listingId, email]);
    await pg.queryPg("update crm_bulk_listings set qualified_at = now(), qualified_by = $2 where id = $1", [listingId, email]);
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_URL;
    pg = await import("../postgres");
    matches = await import("./bulk-matches");
    offers = await import("./bulk-offers");
    events = await import("./bulk-stage-events");
    await pg.queryPg("insert into crm_users (id, email, password_hash) values ($1, $2, 'x') on conflict (id) do nothing", [user, email]);
    for (const n of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 90, 91, 92]) {
      await pg.queryPg("insert into crm_companies (id, name) values ($1, $2)", [id(`co${n}`), `Company ${n} ${run}`]);
      await pg.queryPg("insert into crm_people (id, full_name, email, company_id) values ($1, $2, $3, $4)",
        [id(`pe${n}`), `Person${n} Surname`, `s${n}.${run}@supplier.test`, id(`co${n}`)]);
    }
    for (const n of [2, 3, 4, 5, 6, 7, 8, 92]) {
      await pg.queryPg(
        `insert into crm_stock_opportunities (id, person_id, company_id, status, title, quantity, details) values ($1, $2, $3, 'opportunity', 'Kona pack', $4, $5::jsonb)`,
        [id(`st${n}`), id(`pe${n}`), id(`co${n}`), n === 3 ? null : 30, JSON.stringify(n === 92 ? { availability: { state: "sold" } } : {})]);
    }
    // Requests: qualified under the rule of migration 112 (what, how many and where answered, each checked by a person, and
    // the Qualified tick), owned by Alex as every new deal is. They stay Qualified until a person starts a match run.
    for (const d of ["d1", "d2", "d3", "d4"]) {
      await pg.queryPg(
        `insert into crm_bulk_listings (id, kind, party, company_id, person_id, summary, quantity, location, status, spec, context)
         values ($1, 'demand', 'Motorgreen Ltd', $2, $3, 'Kona packs', '20 packs', 'Leeds, UK', 'open', '{"intent": "request", "product_family": "Hyundai Kona 64 kWh packs"}',
           '{"owner": "Alex"}')`,
        [id(d), id("co0"), id("pe0")]);
      await qualify(id(d));
    }
    await pg.queryPg(
      `insert into crm_bulk_listings (id, kind, party, company_id, person_id, summary, quantity, location, status, closed_reason, spec) values
       ($1, 'supply', 'Seller one', $4, $5, 'Kona lot', '24 packs', 'Leeds, UK', 'open', null, '{}'),
       ($2, 'supply', 'Seller closed', $4, $5, 'Old lot', '5 packs', 'Leeds, UK', 'closed', 'gone', '{}'),
       ($3, 'supply', 'Seller contracted', $4, $5, 'Sold lot', '5 packs', 'Leeds, UK', 'open', null, '{}')`,
      [id("s1"), id("sclosed"), id("scontract"), id("co9"), id("pe9")]);
    await pg.queryPg(`insert into crm_bulk_offers (id, bulk_listing_id, role, name, stage) values ($1, $2, 'counterparty', 'Someone', 'contract_out')`,
      [id("ofc"), id("scontract")]);
  });

  afterAll(async () => {
    await pg.queryPg("delete from crm_bulk_matches where deal_id like $1", [`%_${run}`]);
    await pg.queryPg("delete from crm_bulk_offers where bulk_listing_id like $1", [`%_${run}`]);
    await pg.queryPg("delete from crm_bulk_stage_events where subject_id like $1", [`%_${run}`]);
    await pg.queryPg("delete from crm_bulk_listings where id like $1", [`%_${run}`]);
    await pg.queryPg("delete from crm_stock_opportunities where id like $1", [`%_${run}`]);
    await pg.queryPg("delete from crm_people where id like $1", [`%_${run}`]);
    await pg.queryPg("delete from crm_companies where id like $1", [`%_${run}`]);
    await pg.queryPg("delete from crm_users where id = $1", [user]);
    await pg.pgPool.end();
  });

  it("stores the best five with the scorer's and the model's order, leaving out closed, contracted, sold and declined", async () => {
    // Declined on this deal before: never comes back.
    await pg.queryPg(
      `insert into crm_bulk_matches (id, deal_id, candidate_kind, candidate_id, candidate_key, name, stock_kind, stock_id, state, verdict, verdict_reason, verdict_at)
       values ($1, $2, 'stock', $3, $4, 'Supplier 2', 'stock', $3, 'declined', 'no', 'Price', now())`,
      [id("old"), id("d1"), id("st2"), `stock:${id("st2")}`]);
    const reverse: MatchRanker = {
      model: "stub", prompt: "test",
      rank: async (request) => ({
        order: request.candidates.map((c) => c.id).reverse(),
        reasons: Object.fromEntries(request.candidates.map((c) => [c.id, "Same model, quantity stated."])),
      }),
    };
    // Qualified, owned and nothing asked: still Qualified until a person starts a run.
    expect(await stageOf(id("d1"))).toBe("Qualified");
    const stored = await matches.runMatches(id("d1"), actor, deps({ ranker: reverse }));
    const keys = stored.matches.map((m) => m.candidate_key);
    expect(keys).toEqual([`stock:${id("st6")}`, `stock:${id("st5")}`, `stock:${id("st4")}`, `stock:${id("st3")}`, `supply:${id("s1")}`]);
    expect(stored.matches.map((m) => m.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(stored.matches.map((m) => m.scorer_rank)).toEqual([9, 8, 7, 6, 4]);
    expect(stored.matches[0]).toMatchObject({ state: "proposed", reason: "Same model, quantity stated.", scored_by: { model: "stub", prompt: "test" } });
    expect(stored.matches[0].checks).toMatchObject({ reason: "Model matches: Kona (6)", units: 30 });
    expect(stored.run?.count).toBe(5);
    // Starting the run is marking the deal ready (Alex, 12 Nov): the request moves on to Sourcing, logged with the person.
    expect(await stageOf(id("d1"))).toBe("Sourcing");
    expect(await lastEvent(id("d1"))).toMatchObject({ from_stage: "Qualified", to_stage: "Sourcing", actor: email });
  });

  it("keeps the scorer's order and plain reasons when the model fails or names a counterparty", async () => {
    const broken: MatchRanker = { model: "stub", prompt: "test", rank: async () => { throw new Error("timeout"); } };
    const failed = await matches.runMatches(id("d2"), actor, deps({ ranker: broken }));
    expect(failed.matches.map((m) => m.scorer_rank)).toEqual([4, 5, 6, 7, 8]);
    expect(failed.matches[0].reason).toBe("Fits on model.");
    expect(failed.matches[0].scored_by).toMatchObject({ model: "stub", fallback: "model failed: timeout" });

    const naming: MatchRanker = {
      model: "stub", prompt: "test",
      rank: async (request) => ({
        order: request.candidates.map((c) => c.id),
        reasons: Object.fromEntries(request.candidates.map((c, i) => [c.id, i === 1 ? "Supplier 2 has them for Motorgreen." : "Same model."])),
      }),
    };
    const refused = await matches.runMatches(id("d3"), actor, deps({ ranker: naming }));
    expect(refused.matches.map((m) => m.scorer_rank)).toEqual([4, 5, 6, 7, 8]);
    expect(refused.matches.every((m) => !/Supplier|Motorgreen/.test(m.reason ?? ""))).toBe(true);
    expect(String(refused.matches[0].scored_by.fallback)).toMatch(/^model answer refused: reason for c2 names/);
  });

  it("asks: a draft for a person to send, the match asked, and the request stays Sourcing", async () => {
    const [first] = (await matches.listStoredMatches(id("d1"))).matches;
    const asked = await matches.askMatch(id("d1"), first.id, actor, deps());
    expect(asked).toMatchObject({ kind: "stock_confirm", reused: false });
    expect(drafts.at(-1)?.to).toEqual([`s6.${run}@supplier.test`]);
    expect(drafts.at(-1)?.body).toContain("how many can you offer, at what price, and until when does that price hold?");
    expect(drafts.at(-1)?.body).not.toContain("Motorgreen");
    const after = (await matches.listStoredMatches(id("d1"))).matches[0];
    expect(after.state).toBe("asked");
    expect(after.asked_at).toBeTruthy();
    expect(after.asked?.label).toBe("Asked today, no answer yet");
    expect(await stageOf(id("d1"))).toBe("Sourcing");
    expect(await lastEvent(id("d1"))).toMatchObject({ from_stage: "Qualified", to_stage: "Sourcing", actor: email });
  });

  it("yes makes exactly one offer, and a second yes does not make another", async () => {
    const [first] = (await matches.listStoredMatches(id("d1"))).matches;
    await expect(matches.matchYes(id("d1"), first.id, { quantity: 12 }, actor, deps())).rejects.toThrow(/until when/);
    const input = { quantity: 12, quote: { amount: 1500, currency: "GBP", unit: "unit" }, validUntil: inDays(30) };
    const [a, b] = await Promise.all([
      matches.matchYes(id("d1"), first.id, input, actor, deps()),
      matches.matchYes(id("d1"), first.id, input, actor, deps()),
    ]);
    expect(a.offer_id).toBeTruthy();
    expect(b.offer_id).toBe(a.offer_id);
    await matches.matchYes(id("d1"), first.id, input, actor, deps());
    const rows = await pg.queryPg<{ id: string; stage: string; data: Record<string, unknown>; terms: Record<string, unknown> }>(
      "select id, stage, data, terms from crm_bulk_offers where bulk_listing_id = $1", [id("d1")]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: a.offer_id, stage: "candidate", data: { stock_opportunity_id: id("st6") }, terms: { amount: 1500, currency: "GBP", expires_on: input.validUntil } });
    expect(a).toMatchObject({ state: "confirmed", verdict: "yes", verdict_by: email, confirmed_qty: 12 });
    // The offer's own history starts at candidate, and the request stays Sourcing until something is offered.
    expect((await events.listStageEvents("offer", a.offer_id!)).map((e) => [e.from_stage, e.to_stage])).toEqual([[null, "candidate"]]);
    expect(await stageOf(id("d1"))).toBe("Sourcing");
  });

  it("no needs a reason, and the next best comes in to keep five", async () => {
    const before = (await matches.listStoredMatches(id("d1"))).matches;
    const target = before.find((m) => m.state === "proposed")!;
    await expect(matches.matchNo(id("d1"), target.id, "  ", actor, deps())).rejects.toThrow(/why/);
    const after = await matches.matchNo(id("d1"), target.id, "Price", actor, deps());
    expect(after.matches).toHaveLength(5);
    expect(after.matches.map((m) => m.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(after.matches.some((m) => m.id === target.id)).toBe(false);
    expect(after.matches.at(-1)).toMatchObject({ candidate_key: `stock:${id("st7")}`, state: "proposed", scored_by: { fallback: "pulled in after a no" } });
    expect(after.past.find((m) => m.id === target.id)).toMatchObject({ state: "declined", verdict: "no", verdict_reason: "Price" });
    const history = await pg.queryPg<{ title: string }>("select title from crm_bulk_listing_activity where bulk_listing_id = $1 order by id", [id("d1")]);
    expect(history.map((h) => h.title)).toEqual(expect.arrayContaining(["Found 5 matches", "Yes: Supplier 6", "Not a fit: Supplier 5"]));
  });

  /** Ask and yes on one candidate of a deal, then move its offer to offered, which reserves. */
  async function offer(deal: string, key: string, quantity: number | null) {
    const match = (await matches.listStoredMatches(id(deal))).matches.find((m) => m.candidate_key === key)!;
    const yes = await matches.matchYes(id(deal), match.id, { quantity, validUntil: inDays(30) }, actor, deps());
    await offers.updateOffer(id(deal), yes.offer_id!, { stage: "offered" }, user);
    return (await matches.listStoredMatches(id(deal))).matches.find((m) => m.id === match.id)!;
  }

  it("reserves a quantity: two deals may split a lot, a third over the limit is refused", async () => {
    const key = `stock:${id("st4")}`;
    const one = await offer("d1", key, 12);
    expect(one).toMatchObject({ state: "offered", reserved_qty: 12, reservation_live: true });
    expect(await stageOf(id("d1"))).toBe("Found");
    expect(await lastEvent(id("d1"))).toMatchObject({ from_stage: "Sourcing", to_stage: "Found", actor: email });
    expect(one.reserved_until! >= inDays(0)).toBe(true);
    const two = await offer("d2", key, 15);
    expect(two).toMatchObject({ reserved_qty: 15, reservation_live: true, stock_reserved: { holds: 2, qty: 27, whole: 0 } });
    const three = await offer("d3", key, 10);
    // The offer still moved: the reservation was refused and the card says why.
    expect(three).toMatchObject({ state: "offered", reserved_qty: null, reservation_live: false });
    expect(three.note).toMatch(/Not reserved: Only 3 of 30 are free to reserve/);
    await expect(matches.extendReservation(id("d3"), three.id, actor, deps())).rejects.toThrow(/Only 3 of 30/);

    // The first buyer's offer is declined: its match is a no and its hold ends, so the third deal can reserve.
    await offers.updateOffer(id("d1"), one.offer_id!, { stage: "declined", declinedReason: "Bought elsewhere" }, user);
    const gone = (await matches.listStoredMatches(id("d1"))).past.find((m) => m.id === one.id)!;
    expect(gone).toMatchObject({ state: "declined", verdict: "no", verdict_reason: "Bought elsewhere", reserved_until: null });
    const retried = await matches.extendReservation(id("d3"), three.id, actor, deps());
    expect(retried).toMatchObject({ reserved_qty: 10, reservation_live: true, stock_reserved: { holds: 2, qty: 25, whole: 0 } });
  });

  it("holds a lot of unknown quantity for one deal only, and leaves it out of other runs while held", async () => {
    const key = `stock:${id("st3")}`;
    const one = await offer("d1", key, null);
    expect(one).toMatchObject({ reserved_qty: null, reservation_live: true });
    // A second deal cannot even say yes while it is held; and the database refuses a second hold however it is written.
    await expect(offer("d2", key, 5)).rejects.toThrow(/fully reserved for another deal/);
    await expect(pg.queryPg(
      `update crm_bulk_matches set state = 'offered', reserved_until = current_date + 2 where deal_id = $1 and candidate_key = $2`, [id("d2"), key],
    )).rejects.toThrow(/does not state its quantity and is already reserved/);
    const fresh = await matches.runMatches(id("d4"), actor, deps());
    expect(fresh.matches.map((m) => m.candidate_key)).not.toContain(key);
  });

  it("frees stock once a reservation is out of date, with no write, and expire tidies it", async () => {
    const key = `stock:${id("st3")}`;
    await pg.queryPg("update crm_bulk_matches set reserved_until = $2::date where deal_id = $1 and candidate_key = $3", [id("d1"), yesterday(), key]);
    const view = (await matches.listStoredMatches(id("d1"))).matches.find((m) => m.candidate_key === key)!;
    expect(view.reservation_live).toBe(false);
    const again = await matches.runMatches(id("d4"), actor, deps());
    expect(again.matches.map((m) => m.candidate_key)).toContain(key);
    expect(await matches.expireMatches()).toBeGreaterThanOrEqual(1);
    const expired = (await matches.listStoredMatches(id("d1"))).past.find((m) => m.candidate_key === key)!;
    expect(expired.state).toBe("expired");
    expect(expired.note).toMatch(/Reservation lapsed on/);
  });

  it("a supply listing reserved by a match is Reserved, with a stage event, and Available again once released", async () => {
    const one = await offer("d1", `supply:${id("s1")}`, 10);
    expect(one).toMatchObject({ reserved_qty: 10, reservation_live: true, candidate_qty: 24 });
    expect(await stageOf(id("s1"))).toBe("Reserved");
    expect(await lastEvent(id("s1"))).toMatchObject({ to_stage: "Reserved", actor: email });
    expect(await matches.listingReservations(id("s1"))).toMatchObject({ holds: 1, qty: 10, of: 24 });
    await matches.releaseReservation(id("d1"), one.id, actor, deps());
    expect(await stageOf(id("s1"))).toBe("Available");
    expect(await lastEvent(id("s1"))).toMatchObject({ from_stage: "Reserved", to_stage: "Available" });
  });

  it("marks new supply that may fit a standing request, and nothing more", async () => {
    await pg.queryPg(
      `insert into crm_bulk_listings (id, kind, party, company_id, person_id, summary, quantity, status, spec)
       values ($1, 'demand', 'Motorgreen Ltd', $2, $3, 'Kona packs', '20 packs', 'open', '{"intent": "standing", "basis": "stated", "product_family": "Kona packs"}')`,
      [id("d5"), id("co0"), id("pe0")]);
    await matches.runMatches(id("d5"), actor, deps());
    expect(await matches.markNewSupply(id("d5"), actor, deps())).toBe(0);
    await pg.queryPg(`insert into crm_stock_opportunities (id, person_id, company_id, status, title, quantity) values ($1, $2, $3, 'opportunity', 'Kona pack', 4)`,
      [id("st9"), id("pe9"), id("co9")]);
    const withNew = async (deal: { id: string }) => result(deal.id, [...demandRows(), supplier(9)]);
    expect(await matches.markNewSupply(id("d5"), actor, deps({ scorer: withNew }))).toBe(1);
    const view = await matches.listStoredMatches(id("d5"));
    expect(view.markers).toHaveLength(1);
    expect(view.markers[0]).toMatchObject({ candidate_key: `stock:${id("st9")}`, state: "proposed", rank: null, note: "New supply may fit" });
    expect(view.matches).toHaveLength(5);
    // Checked once: the same new line is not marked again.
    expect(await matches.markNewSupply(id("d5"), actor, deps({ scorer: withNew }))).toBe(0);
    // A one-off request gets no markers.
    expect(await matches.markNewSupply(id("d4"), actor, deps({ scorer: withNew }))).toBe(0);
  });

  it("marks supply that became Qualified since the last check, for every standing request at once (A3)", async () => {
    // A supply listing made before the last check, ticked Qualified after it: new supply for d5 now.
    await pg.queryPg(`insert into crm_bulk_listings (id, kind, party, company_id, person_id, summary, quantity, location, status, spec, created_at)
      values ($1, 'supply', 'Seller three', $2, $3, 'Kona lot', '6 packs', 'Leeds, UK', 'open', '{}', now() - interval '2 days')`, [id("s3"), id("co9"), id("pe9")]);
    const before = await pg.queryPg<{ checked: string }>("select context->'match_run'->>'checked_at' as checked from crm_bulk_listings where id = $1", [id("d5")]);
    await pg.queryPg("update crm_bulk_listings set qualified_at = now(), qualified_by = $2 where id = $1", [id("s3"), email]);
    const withS3 = async (deal: { id: string }) => result(deal.id, [...demandRows(), supplier(9), supplier(3, { key: `supply:${id("s3")}`, stockId: null, units: 6 })]);
    expect(await matches.markNewSupplyForStanding(actor, deps({ scorer: withS3 }))).toBe(1);
    const markers = (await matches.listStoredMatches(id("d5"))).markers.map((m) => m.candidate_key);
    expect(markers).toContain(`supply:${id("s3")}`);
    expect(before[0].checked).toBeTruthy();
    // Idempotent: run again, nothing new.
    expect(await matches.markNewSupplyForStanding(actor, deps({ scorer: withS3 }))).toBe(0);
  });

  describe("a supply deal", () => {
    const buyers = (dealId: string) => result(dealId, [
      { ...supplier(1), key: `demand:${id("d4")}`, name: "Motorgreen Ltd", tags: ["live ask"], companyId: id("co0"), personId: id("pe0"), contact: `s0.${run}@supplier.test`, units: null, stockId: null },
      { ...supplier(8), key: `company:${id("co8")}`, name: "Buyer eight", tags: [], stockId: null, units: null },
    ], { kind: "supply", units: 24 });

    beforeAll(async () => {
      await pg.queryPg(
        `insert into crm_bulk_listings (id, kind, party, company_id, person_id, summary, quantity, location, status, spec)
         values ($1, 'supply', 'Seller two', $2, $3, 'Kona lot', '24 packs', 'Leeds, UK', 'open', '{}')`, [id("s2"), id("co9"), id("pe9")]);
      await pg.queryPg(`insert into crm_bulk_listing_fields (bulk_listing_id, field_key, value, status, visibility) values
        ($1, 'seller_price', '1,495 GBP per pack', 'unverified', 'never'), ($1, 'quantity', '24', 'confirmed', 'teaser')`, [id("s2")]);
    });

    it("blocks buyer drafts until the seller re-confirms the quote, then offers buyers and reserves the lot", async () => {
      const stored = await matches.runMatches(id("s2"), actor, deps({ scorer: async () => buyers(id("s2")) }));
      expect(stored.sellerQuote).toMatchObject({ inDate: false });
      const [first] = stored.matches;
      await expect(matches.askMatch(id("s2"), first.id, actor, deps())).rejects.toThrow(/seller's quote is missing or out of date/);
      await expect(matches.matchYes(id("s2"), first.id, {}, actor, deps())).rejects.toThrow(/seller's quote/);

      const reconfirm = await matches.sellerReconfirm(id("s2"), actor, deps());
      expect(reconfirm.kind).toBe("seller_reconfirm");
      expect(drafts.at(-1)?.to).toEqual([`s9.${run}@supplier.test`]);
      expect(drafts.at(-1)?.body).not.toMatch(/1,495|Motorgreen/);
      await expect(matches.recordSellerQuote(id("s2"), yesterday(), actor, deps())).rejects.toThrow(/from today/);
      expect(await matches.recordSellerQuote(id("s2"), inDays(3), actor, deps())).toMatchObject({ status: "confirmed", inDate: true });

      const asked = await matches.askMatch(id("s2"), first.id, actor, deps());
      expect(asked.kind).toBe("supply_offer");
      expect(drafts.at(-1)?.body).toContain("Price on request.");
      expect(drafts.at(-1)?.body).not.toMatch(/Seller two|1,495/);
      const yes = await matches.matchYes(id("s2"), first.id, { quantity: 8 }, actor, deps());
      await offers.updateOffer(id("s2"), yes.offer_id!, { stage: "offered" }, user);
      const offered = (await matches.listStoredMatches(id("s2"))).matches.find((m) => m.id === first.id)!;
      // Held for 5 working days or to the quote's last day if sooner: here the quote ends first.
      expect(offered).toMatchObject({ state: "offered", reserved_qty: 8, reserved_until: inDays(3), reservation_live: true, candidate_qty: 24 });
      expect(await stageOf(id("s2"))).toBe("Reserved");
    });
  });
});
