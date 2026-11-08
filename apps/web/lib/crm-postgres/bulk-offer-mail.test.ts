import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Runs only against a disposable database: scripts/rebattery/crm-test-db.sh up prints the URL.
const TEST_URL = process.env.BULK_TRADES_TEST_DATABASE_URL;

describe.skipIf(!TEST_URL)("offer outreach (matches v3, slice 2)", () => {
  let pg: typeof import("../postgres");
  let mail: typeof import("./bulk-offer-mail");
  const run = Math.random().toString(36).slice(2, 8);
  const id = (s: string) => `${s}_${run}`;

  const listing = (lid: string, kind: "supply" | "demand", company: string | null, status = "open", location: string | null = null) =>
    pg.queryPg(
      `insert into crm_bulk_listings (id, kind, party, company_id, person_id, summary, status, location, spec, context)
       values ($1, $2, $3, $4, $5, $3, $6, $7, '{}'::jsonb, '{}'::jsonb)`,
      [lid, kind, `Party ${lid}`, company, id("seller_person"), status, location]);

  const offer = (oid: string, lid: string, stage: string, data: object = {}, person: string | null = null, company: string | null = null) =>
    pg.queryPg(
      `insert into crm_bulk_offers (id, bulk_listing_id, role, person_id, company_id, name, contact, stage, data)
       values ($1, $2, 'counterparty', $3, $4, $5, $6, $7, $8::jsonb)`,
      [oid, lid, person, company, `Buyer ${oid}`, person ? `${person}@buyer.test` : null, stage, JSON.stringify(data)]);

  const sentMail = async (mid: string, oid: string, lid: string, when: string, replied: string | null = null) => {
    await pg.queryPg(`insert into mail_thread (id) values ($1) on conflict do nothing`, [id(`th_${mid}`)]);
    await pg.queryPg(
      `insert into mail_message (id, direction, transport, state, purpose, identity_key, thread_id, subject, from_email, to_emails, sent_at)
       values ($1, 'outbound', 'gmail', 'accepted', 'personal', 'alex', $2, 'Offer email', 'alex@rebattery.io', array['buyer@buyer.test'], $3)`,
      [mid, id(`th_${mid}`), when]);
    await pg.queryPg(
      `insert into crm_bulk_offer_mail (message_id, bulk_listing_id, offer_id, thread_id, sent_at, matched_by, replied_at)
       values ($1, $2, $3, $4, $5, 'thread_link', $6)`,
      [mid, lid, oid, id(`th_${mid}`), when, replied]);
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_URL;
    pg = await import("../postgres");
    mail = await import("./bulk-offer-mail");
    for (const c of ["buyerco", "supplierco"]) await pg.queryPg(`insert into crm_companies (id, name) values ($1, $1)`, [id(c)]);
    for (const p of ["buyer1", "buyer2", "buyer3", "supplier1", "seller_person"]) {
      await pg.queryPg(`insert into crm_people (id, full_name, email) values ($1, $2, $3)`, [id(p), `${p} Person`, `${p}_${run}@buyer.test`]);
    }
    await pg.queryPg(`update crm_people set email_opted_out = true where id = $1`, [id("buyer3")]);
    await listing(id("sup"), "supply", id("buyerco"), "open", "Unit 4, 12 Foo Street, Rotterdam, Netherlands");
    await listing(id("dem"), "demand", id("buyerco"), "open", "Leeds, United Kingdom");
    await pg.queryPg(
      `insert into crm_bulk_listing_fields (bulk_listing_id, field_key, value, status, visibility) values
        ($1, 'capacity', '50 kWh per pack', 'confirmed', 'teaser'), ($1, 'format', 'Packs', 'confirmed', 'teaser'),
        ($1, 'quantity', '40 packs', 'confirmed', 'teaser'), ($1, 'seller_price', 'EUR 40 per kWh', 'confirmed', 'teaser'),
        ($1, 'test_data', 'BMS report supplied', 'confirmed', 'teaser')`, [id("sup")]);
  });

  afterAll(async () => {
    await pg.queryPg(`delete from archive.crm_stock_opportunities where person_id like $1`, [`%_${run}`]);
    await pg.queryPg(`delete from crm_stock_opportunities where person_id like $1`, [`%_${run}`]);
    await pg.queryPg(`delete from crm_bulk_listings where id like $1`, [`%_${run}`]);
    await pg.queryPg(`delete from crm_companies where id like $1`, [`%_${run}`]);
    await pg.queryPg(`delete from mail_message where id like $1`, [`%_${run}%`]);
    await pg.queryPg(`delete from mail_thread where id like $1`, [`%_${run}%`]);
    await pg.queryPg(`delete from crm_people where id like $1`, [`%_${run}`]);
  });

  it("refuses an opted-out contact and a contact with no address", async () => {
    await offer(id("o_opted_out"), id("sup"), "candidate", {}, id("buyer3"));
    const opted = await mail.offerOutreach(id("sup"), id("o_opted_out"));
    expect(opted?.blocked).toMatch(/opted out/);

    await offer(id("o_no_email"), id("sup"), "candidate", {}, null, null);
    const none = await mail.offerOutreach(id("sup"), id("o_no_email"));
    expect(none?.email).toBeNull();
    expect(none?.blocked).toMatch(/no email address/);
  });

  it("builds the facts the template needs, and keeps the seller out of the private list's town", async () => {
    await offer(id("o_facts"), id("sup"), "candidate", {}, id("buyer1"));
    const facts = await mail.offerOutreach(id("sup"), id("o_facts"));
    expect(facts?.email).toBe(`${id("buyer1")}@buyer.test`);
    expect(facts?.recipientFirstName).toBe("buyer1");
    expect(facts?.product.key.sellerPrice?.eurPerKwh).toBe(40);
    expect(facts?.product.fields.find((field) => field.field_key === "test_data")?.value).toBe("BMS report supplied");
    expect(facts?.chaseDue).toBe(false);
    // The exact address is forbidden, the town is not.
    expect(facts?.privateValues).toContain("Unit 4");
    expect(facts?.privateValues).not.toContain("Rotterdam");
  });

  it("moves candidate to offered once, stamps the touch, clears the open draft and never moves backwards", async () => {
    await offer(id("o_send"), id("sup"), "candidate", { open_draft_id: id("draft") }, id("buyer1"));
    const first = await mail.markOfferSent(id("o_send"), null);
    expect(first).toEqual({ moved: true, stage: "offered" });
    const [row] = await pg.queryPg<{ stage: string; last_touch_via: string; open: string | null }>(
      `select stage, last_touch_via, data->>'open_draft_id' as open from crm_bulk_offers where id = $1`, [id("o_send")]);
    expect(row.stage).toBe("offered");
    expect(row.last_touch_via).toBe("mail");
    expect(row.open).toBeNull();
    const second = await mail.markOfferSent(id("o_send"), null);
    expect(second).toEqual({ moved: false, stage: "offered" });
    const [{ count }] = await pg.queryPg<{ count: number }>(
      `select count(*)::int from crm_bulk_listing_activity where offer_id = $1 and data->>'stage' = 'offered'`, [id("o_send")]);
    expect(count).toBe(1);

    await offer(id("o_negotiating"), id("sup"), "negotiating", { open_draft_id: id("draft2") }, id("buyer1"));
    expect(await mail.markOfferSent(id("o_negotiating"), null)).toEqual({ moved: false, stage: "negotiating" });
    const [kept] = await pg.queryPg<{ stage: string }>(`select stage from crm_bulk_offers where id = $1`, [id("o_negotiating")]);
    expect(kept.stage).toBe("negotiating");
  });

  it("links the sent thread as confirmed, and confirms a proposed link that already exists", async () => {
    await offer(id("o_link"), id("sup"), "offered", {}, id("buyer1"));
    await pg.queryPg(
      `insert into crm_bulk_thread_links (channel, thread_id, bulk_listing_id, offer_id, confidence, state, labelled_by)
       values ('mail', $1, $2, $3, 'high', 'proposed', 'test')`, [id("th_link"), id("sup"), id("o_link")]);
    await mail.linkOfferThread(id("sup"), id("o_link"), id("th_link"), "alex@rebattery.io");
    const [link] = await pg.queryPg<{ state: string; confirmed_by: string }>(
      `select state, confirmed_by from crm_bulk_thread_links where offer_id = $1`, [id("o_link")]);
    expect(link.state).toBe("confirmed");
    expect(link.confirmed_by).toBe("alex@rebattery.io");
  });

  it("chases an offered offer whose only email is unanswered and more than three working days old", async () => {
    const longAgo = "2026-10-05T09:00:00Z";   // a Monday
    const recent = "2026-11-02T09:00:00Z";     // the Monday of the test week
    await offer(id("o_chase"), id("sup"), "offered", {}, id("buyer1"));
    await sentMail(id(`m_chase_${run}`), id("o_chase"), id("sup"), longAgo);
    await offer(id("o_fresh"), id("sup"), "offered", {}, id("buyer1"));
    await sentMail(id(`m_fresh_${run}`), id("o_fresh"), id("sup"), recent);
    await offer(id("o_replied"), id("sup"), "offered", {}, id("buyer1"));
    await sentMail(id(`m_replied_${run}`), id("o_replied"), id("sup"), longAgo, "2026-10-06T09:00:00Z");
    await offer(id("o_candidate"), id("sup"), "candidate", {}, id("buyer1"));
    await sentMail(id(`m_cand_${run}`), id("o_candidate"), id("sup"), longAgo);

    const now = new Date("2026-11-04T12:00:00Z");
    const due = (await mail.chaseOffers(id("sup"), now)).map((row) => row.offerId);
    expect(due).toContain(id("o_chase"));
    expect(due).not.toContain(id("o_fresh"));
    expect(due).not.toContain(id("o_replied"));
    expect(due).not.toContain(id("o_candidate"));
    expect((await mail.offerOutreach(id("sup"), id("o_chase"), now))?.chaseDue).toBe(true);
  });

  it("marks exactly the linked stock line stale on a request, and nothing without the link", async () => {
    await pg.queryPg(
      `insert into crm_stock_opportunities (id, person_id, company_id, status, title) values
        ($1, $2, $3, 'opportunity', 'Linked line'), ($4, $2, $3, 'opportunity', 'Other line')`,
      [id("sto_one"), id("supplier1"), id("supplierco"), id("sto_two")]);
    await offer(id("o_stock"), id("dem"), "declined", { stock_opportunity_id: id("sto_one") }, id("supplier1"));
    await offer(id("o_nolink"), id("dem"), "declined", {}, id("supplier1"));
    await offer(id("o_supply_side"), id("sup"), "declined", { stock_opportunity_id: id("sto_one") }, id("buyer1"));

    expect(await mail.markNoStock(id("dem"), id("o_stock"), "demand", null)).toEqual({ marked: id("sto_one"), suggestion: null });
    // A stale row leaves the live table for the archive in the same statement (migration 102).
    const live = await pg.queryPg<{ id: string; status: string }>(
      `select id, status from crm_stock_opportunities where id = any($1) order by id`, [[id("sto_one"), id("sto_two")]]);
    expect(live).toEqual([{ id: id("sto_two"), status: "opportunity" }]);
    const archived = await pg.queryPg<{ id: string; status: string; stale_offer: string | null }>(
      `select id, status, details->'stale'->>'offer_id' as stale_offer from archive.crm_stock_opportunities where id = $1`, [id("sto_one")]);
    expect(archived).toEqual([{ id: id("sto_one"), status: "stale", stale_offer: id("o_stock") }]);
    const [note] = await pg.queryPg<{ n: number }>(
      `select count(*)::int as n from crm_bulk_listing_activity where offer_id = $1 and title like 'No stock:%'`, [id("o_stock")]);
    expect(note.n).toBe(1);

    expect(await mail.markNoStock(id("dem"), id("o_nolink"), "demand", null)).toEqual({ marked: null, suggestion: null });
    expect((await mail.markNoStock(id("sup"), id("o_supply_side"), "supply", null)).suggestion).toMatch(/Close the listing/);
    const [untouched] = await pg.queryPg<{ status: string }>(`select status from crm_stock_opportunities where id = $1`, [id("sto_two")]);
    expect(untouched.status).toBe("opportunity");
  });
});
