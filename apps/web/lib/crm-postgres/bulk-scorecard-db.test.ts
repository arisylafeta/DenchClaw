import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeScorecard, type ScorecardFacts } from "../bulk-scorecard";

// Runs only against a disposable database: scripts/rebattery/crm-test-db.sh up prints the URL. Synthetic rows only.
const TEST_URL = process.env.BULK_TRADES_TEST_DATABASE_URL;

// Tuesday 15 Dec 2026: the week reported is 7 to 13 Dec, the week before 30 Nov to 6 Dec.
const NOW = new Date("2026-12-15T09:00:00Z");

describe.skipIf(!TEST_URL)("scorecard reads (slice 6)", () => {
  let pg: typeof import("../postgres");
  let sc: typeof import("./bulk-scorecard");
  const run = Math.random().toString(36).slice(2, 8);
  const id = (s: string) => `t6_${s}_${run}`;
  let alex: string;

  /** The scorecard over this test's rows only: other test files share the database. */
  const mine = (f: ScorecardFacts): ScorecardFacts => ({
    enquiries: f.enquiries.filter((e) => e.id.endsWith(run)),
    listings: f.listings.filter((l) => l.id.endsWith(run)),
    sheet: f.sheet.filter((r) => r.id.endsWith(run)),
    events: f.events.filter((e) => e.listing_id.endsWith(run)),
    runs: f.runs.filter((r) => r.deal_id.endsWith(run)),
    offers: f.offers.filter((o) => o.id.endsWith(run)),
  });

  /** Moves the stage events a trigger wrote at the real now to the synthetic dates of the story. */
  const eventAt = (subject: string, to: string, at: string) => pg.queryPg(
    "update crm_bulk_stage_events set occurred_at = $3 where subject_id = $1 and to_stage = $2", [subject, to, at]);

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_URL;
    pg = await import("../postgres");
    sc = await import("./bulk-scorecard");
    [{ id: alex }] = await pg.queryPg<{ id: string }>("insert into crm_users (email, display_name, password_hash) values ($1, 'Alex Polglase', 'x') returning id", [`alex.${run}@example.test`]);

    // Listings: the supply deal Relay opened from a card, a request with a match run, one stuck in New, a Jules lot and a research row.
    await pg.queryPg(`insert into crm_bulk_listings (id, kind, party, summary, status, spec, source_kind, created_at) values
      ($1, 'supply', 'Seller one', 'Leaf packs', 'open', '{"seller_quote_valid_until": "2026-12-31"}', 'email', '2026-12-07T11:00:00Z'),
      ($2, 'demand', 'Buyer one', 'Kona packs', 'open', '{"intent": "request"}', 'manual', '2026-12-01T10:00:00Z'),
      ($3, 'supply', 'Old seller', 'Zoe packs', 'open', '{}', 'manual', '2026-11-20T09:00:00Z'),
      ($4, 'supply', 'Jules seller', 'Model 3 packs', 'open', '{}', 'jules', '2026-12-09T09:00:00Z'),
      ($5, 'supply', 'Stranded project', 'BESS racks', 'open', '{}', 'research', '2026-12-08T09:00:00Z')`,
      [id("sup"), id("dem"), id("old"), id("jul"), id("res")]);
    await eventAt(id("old"), "New", "2026-11-20T09:00:00Z");
    await eventAt(id("res"), "New", "2026-11-20T09:00:00Z");
    await eventAt(id("jul"), "New", "2026-12-09T09:00:00Z");
    await pg.queryPg(`insert into crm_bulk_listing_fields (bulk_listing_id, field_key, value, status, visibility) values ($1, 'seller_price', 'GBP 80/kWh', 'confirmed', 'never')`, [id("sup")]);

    // Enquiry 1: a seller's first email, answered in an hour; the card opened the supply deal when the reply went.
    // Enquiry 2: dismissed as Not a lead the next morning. Enquiry 3: someone we had written to before (not new).
    for (const n of ["1", "2", "3"]) await pg.queryPg("insert into mail_thread (id, subject) values ($1, 'Packs')", [id(`th${n}`)]);
    await pg.queryPg(`insert into mail_message (id, thread_id, direction, transport, state, purpose, from_email, to_emails, subject, sent_at, accepted_at) values
      ($1, $4, 'inbound', 'gmail', 'received', null, $7, '{supply@rebattery.io}', 'Packs', '2026-12-07T10:00:00Z', null),
      ($2, $4, 'outbound', 'gmail', 'accepted', 'personal', 'alex@rebattery.io', array[$7], 'Re: Packs', '2026-12-07T11:00:00Z', '2026-12-07T11:00:00Z'),
      ($3, $5, 'inbound', 'gmail', 'received', null, $8, '{supply@rebattery.io}', 'Packs', '2026-12-08T09:30:00Z', null),
      ($9, $6, 'inbound', 'gmail', 'received', null, $10, '{buy@rebattery.io}', 'Packs', '2026-12-09T09:30:00Z', null),
      ($11, null, 'outbound', 'gmail', 'accepted', 'personal', 'alex@rebattery.io', array[$10], 'Hello', '2026-11-01T09:30:00Z', '2026-11-01T09:30:00Z')`,
      [id("in1"), id("out1"), id("in2"), id("th1"), id("th2"), id("th3"), `seller1.${run}@s1.example`, `seller2.${run}@s2.example`,
        id("in3"), `buyer3.${run}@b3.example`, id("before3")]);
    await pg.queryPg(`insert into relay_item (id, owner_id, gmail_thread_id, mail_thread_id, tab, contact_type, bulk_listing_id) values
      ($1, $4::uuid, $1, $5, 'action', 'supplier', $8), ($2, $4::uuid, $2, $6, 'action', 'supplier', null), ($3, $4::uuid, $3, $7, 'action', 'buyer', null)`,
      [id("item1"), id("item2"), id("item3"), alex, id("th1"), id("th2"), id("th3"), id("sup")]);
    const sent = { route: { route: "bulk" }, deal_id: id("sup"), opened: true, asked: [], at: "2026-12-07T11:00:00Z" };
    await pg.queryPg(`insert into relay_card (item_id, owner_id, message_id, status, data, updated_at) values
      ($1, $3::uuid, $4, 'sent', $6::jsonb, '2026-12-07T11:00:00Z'), ($2, $3::uuid, $5, 'dismissed', $7::jsonb, '2026-12-08T10:00:00Z')`,
      [id("item1"), id("item2"), alex, id("in1"), id("in2"),
        JSON.stringify({ lead: { route: { route: "bulk", size: "bulk", reason: "300 kWh" } }, sent }), JSON.stringify({ lead: { route: { route: "recycling", size: "unknown", reason: "scrap" } } })]);

    // Offers to buyers on the supply deal: one walked to paid with every step on record, one quiet since early November,
    // one offered priced and in date then lost, one offered without a price.
    const offer = (key: string, stage: string, terms: object, created: string) => pg.queryPg(
      `insert into crm_bulk_offers (id, bulk_listing_id, role, name, stage, terms, created_at) values ($1, $2, 'counterparty', $3, $4, $5::jsonb, $6)`,
      [id(key), id("sup"), `Buyer ${key}`, stage, JSON.stringify(terms), created]);
    const priced = { amount: 100, currency: "GBP", unit: "kwh" };
    await offer("o_full", "offered", priced, "2026-11-30T10:00:00Z");
    await pg.queryPg(`update crm_bulk_offers set stage = 'paid', quantity = 10, paid_on = '2026-12-09', paid_amount = 1000, paid_currency = 'GBP', take_gbp = 120 where id = $1`, [id("o_full")]);
    await eventAt(id("o_full"), "offered", "2026-12-01T10:00:00Z");
    await eventAt(id("o_full"), "paid", "2026-12-09T10:00:00Z");
    await pg.queryPg(`insert into crm_bulk_matches (id, deal_id, candidate_kind, candidate_id, candidate_key, name, stock_kind, stock_id, state, verdict, verdict_at, offer_id, created_at)
      values ($1, $2, 'company', $3, $4, 'Buyer o_full', 'listing', $2, 'offered', 'yes', '2026-11-26T10:00:00Z', $5, '2026-11-25T10:00:00Z')`,
      [id("m_full"), id("sup"), id("buyerco"), `company:${id("buyerco")}`, id("o_full")]);
    await pg.queryPg(`insert into crm_bulk_listing_documents (id, bulk_listing_id, title, doc_type, state, direction, url, visibility) values ($1, $2, 'Price sheet PS-1a2b3c4d', 'Quote', 'sent', 'sent', 'https://example.test/ps', 'never')`, [id("doc"), id("sup")]);
    await pg.queryPg(`insert into crm_bulk_listing_activity (bulk_listing_id, offer_id, kind, title, data) values ($1, $2, 'document', 'Document sent: Price sheet', $3::jsonb)`,
      [id("sup"), id("o_full"), JSON.stringify({ document_id: id("doc") })]);
    await offer("o_quiet", "offered", {}, "2026-11-01T10:00:00Z");
    await eventAt(id("o_quiet"), "offered", "2026-11-02T10:00:00Z");
    await offer("o_lost", "offered", { amount: 90, currency: "GBP", unit: "kwh" }, "2026-12-08T09:00:00Z");
    await pg.queryPg("update crm_bulk_offers set stage = 'lost', declined_reason = 'Bought elsewhere' where id = $1", [id("o_lost")]);
    await eventAt(id("o_lost"), "offered", "2026-12-08T10:00:00Z");
    await eventAt(id("o_lost"), "lost", "2026-12-10T10:00:00Z");
    await offer("o_unpriced", "offered", {}, "2026-12-09T09:00:00Z");
    await eventAt(id("o_unpriced"), "offered", "2026-12-09T10:00:00Z");

    // A match run on the request, both candidates judged in two working days; a run on the research row is left out.
    await pg.queryPg(`insert into crm_bulk_listing_activity (bulk_listing_id, kind, title, data, occurred_at) values
      ($1, 'supply', 'Found 2 matches', '{"match_run": {"count": 2}}', '2026-12-07T10:00:00Z'),
      ($2, 'supply', 'Found 3 matches', '{"match_run": {"count": 3}}', '2026-12-08T10:00:00Z')`, [id("dem"), id("res")]);
    await pg.queryPg(`insert into crm_bulk_matches (id, deal_id, candidate_kind, candidate_id, candidate_key, name, stock_kind, stock_id, state, verdict, verdict_reason, verdict_at, verdict_by) values
      ($1, $3, 'stock', $4, $4, 'Lot A', 'stock', $4, 'confirmed', 'yes', null, '2026-12-08T10:00:00Z', 'alex'),
      ($2, $3, 'stock', $5, $5, 'Lot B', 'stock', $5, 'declined', 'no', 'Wrong chemistry', '2026-12-09T10:00:00Z', 'alex')`,
      [id("m_a"), id("m_b"), id("dem"), id("stock_a"), id("stock_b")]);

    // Housekeeping: a reservation past its last day still marked offered, and a hold that ended with no stage event.
    await pg.queryPg(`insert into crm_bulk_matches (id, deal_id, candidate_kind, candidate_id, candidate_key, name, stock_kind, stock_id, state, reserved_qty, reserved_until)
      values ($1, $2, 'stock', $3, $3, 'Lot C', 'stock', $3, 'offered', 5, current_date - 3)`, [id("m_lapsed"), id("dem"), id("stock_c")]);
    await pg.queryPg(`insert into crm_bulk_listings (id, kind, party, summary, status, spec, hold_until, hold_reason) values ($1, 'supply', 'Held seller', 'Held packs', 'open', '{}', current_date - 1, 'Seller away')`, [id("held")]);
    await pg.queryPg("update crm_bulk_stage_events set to_stage = 'Reserved', occurred_at = '2026-12-10T09:00:00Z' where subject_kind = 'listing' and subject_id = $1", [id("held")]);
  });

  afterAll(async () => {
    await pg.queryPg("delete from relay_item where id like $1", [`%_${run}`]);
    await pg.queryPg("delete from crm_bulk_matches where id like $1", [`%_${run}`]);
    await pg.queryPg("delete from crm_bulk_listings where id like $1", [`%_${run}`]);
    await pg.queryPg("delete from crm_bulk_stage_events where subject_id like $1", [`%_${run}`]);
    await pg.queryPg("delete from mail_message where id like $1", [`%_${run}`]);
    await pg.queryPg("delete from mail_thread where id like $1", [`%_${run}`]);
    await pg.queryPg("delete from crm_users where id = $1", [alex]);
    await pg.pgPool.end();
  });

  it("reads in a transaction that refuses writes", async () => {
    await expect(sc.readOnly((tx) => tx.query("insert into mail_thread (id, subject) values ($1, 'x')", [id("nope")]))).rejects.toThrow(/read-only/);
    const [left] = await pg.queryPg<{ n: number }>("select count(*)::int as n from mail_thread where id = $1", [id("nope")]);
    expect(left.n).toBe(0);
  });

  it("works out every measure from the live tables, research left out, Jules on its own", async () => {
    const facts = mine(await sc.readOnly((tx) => sc.scorecardFacts(tx, "2026-11-30T00:00:00Z")));
    // Enquiry 3 is someone we wrote to before: not a new enquiry.
    expect(facts.enquiries.map((e) => e.id).sort()).toEqual([id("item1"), id("item2")]);
    expect(facts.sheet.map((r) => r.id)).not.toContain(id("res"));
    expect(facts.offers.find((o) => o.id === id("o_full"))).toMatchObject({ side: "buyer", from_card: true, sheet_sent: true, take_gbp: 120,
      quote: { value: "GBP 80/kWh", status: "confirmed", validUntil: "2026-12-31" }, match: { verdict: "yes" } });

    const card = computeScorecard(facts, NOW);
    const week = Object.fromEntries(card.week.map((m) => [m.key, m]));
    expect(week.reply).toMatchObject({ numerator: 1, denominator: 1 });
    // A deal opened from the card, and a card dismissed as Not a lead: both decided in time.
    expect(week.decide).toMatchObject({ numerator: 2, denominator: 2 });
    expect(week.stuck).toMatchObject({ value: 1 });
    expect(week.judged).toMatchObject({ numerator: 1, denominator: 1 });
    expect(week.quiet).toMatchObject({ value: 1 });
    expect(week.quoted).toMatchObject({ numerator: 1, denominator: 2 });
    expect(week.speed).toMatchObject({ value: 14 });
    expect(week.won).toMatchObject({ numerator: 1, denominator: 2 });
    expect(week.take).toMatchObject({ value: 120, shown: "£120" });
    expect(week.prepared).toMatchObject({ value: 1, shown: "1 of 1 paid" });
    expect(card.intake.week).toEqual({ listings: 1, jules: 1, research_left_out: 1 });
    // The week before: the full offer went out then; nothing else was counted.
    const before = Object.fromEntries(card.previous.map((m) => [m.key, m]));
    expect(before.quoted).toMatchObject({ numerator: 1, denominator: 1 });
    expect(before.reply.shown).toBe("no data yet");
    expect(before.take.shown).toBe("no data yet");
  });

  it("finds the housekeeping the daily functions would do, with SELECTs only", async () => {
    const house = await sc.housekeeping();
    expect(house.lapsed.count).toBeGreaterThanOrEqual(1);
    expect(house.behind.ids).toContain(id("held"));
    expect(house.behind.holdsEnded).toBeGreaterThanOrEqual(1);
    // Nothing was changed: the reservation is still offered and the hold's last event still says Reserved.
    const [m] = await pg.queryPg<{ state: string }>("select state from crm_bulk_matches where id = $1", [id("m_lapsed")]);
    expect(m.state).toBe("offered");
  });
});
