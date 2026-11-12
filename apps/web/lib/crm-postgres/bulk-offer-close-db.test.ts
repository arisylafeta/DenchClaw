import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Offer to close on a disposable database (scripts/rebattery/crm-test-db.sh up prints the URL): the quote gate and margin
// from stored rows, a price sheet kept with the deal's documents and marked sent with the email, and two walks through
// the stages so slice 1's trigger (complete closes both listings) and slice 4's (declined or lost ends the match and its
// reservation) are seen working together. No mail is sent and no model is called: nothing here reaches either.
const TEST_URL = process.env.BULK_TRADES_TEST_DATABASE_URL;

describe.skipIf(!TEST_URL)("offer to close (slice 5)", () => {
  let pg: typeof import("../postgres");
  let close: typeof import("./bulk-offer-close");
  let offers: typeof import("./bulk-offers");
  let mail: typeof import("./bulk-offer-mail");
  let events: typeof import("./bulk-stage-events");
  const run = Math.random().toString(36).slice(2, 8);
  const id = (s: string) => `${s}_${run}`;
  const user = "7d0e5d38-5b6f-4a37-9d77-000000000115";
  const email = `alex+${run}@rebattery.io`;
  const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  const SELLER = `Northern Salvage ${run}`;

  const supply = async (listing: string, validUntil: string) => {
    await pg.queryPg(
      `insert into crm_bulk_listings (id, kind, party, company_id, person_id, summary, quantity, location, status, spec)
       values ($1, 'supply', $2, $3, $4, 'Kona lot', '24 packs', 'Unit 4 Mill Road, Leeds, United Kingdom', 'open', $5::jsonb)`,
      [listing, SELLER, id("cos"), id("pes"), JSON.stringify({ seller_quote_valid_until: validUntil })]);
    const rows: [string, string, string, string][] = [
      ["model", "Hyundai Kona pack", "confirmed", "teaser"], ["capacity", "64 kWh per pack", "confirmed", "teaser"],
      ["format", "Packs", "confirmed", "teaser"], ["chemistry", "NMC", "confirmed", "teaser"], ["quantity", "24 packs", "confirmed", "teaser"],
      ["location", "Leeds, United Kingdom", "confirmed", "teaser"], ["seller_price", "GBP 2,000 per pack", "confirmed", "never"],
    ];
    for (const [key, value, status, visibility] of rows) {
      await pg.queryPg(
        `insert into crm_bulk_listing_fields (bulk_listing_id, field_key, value, status, visibility, source_label) values ($1, $2, $3, $4, $5, 'test')`,
        [listing, key, value, status, visibility]);
    }
  };
  /** A buyer's yes on the supply deal: the match the offer came from, holding 12 of the 24 packs once offered. */
  const matched = async (match: string, deal: string, request: string, offer: string) => {
    await pg.queryPg(
      `insert into crm_bulk_matches (id, deal_id, candidate_kind, candidate_id, candidate_key, name, stock_kind, stock_id, candidate_qty,
         state, verdict, verdict_at, confirmed_qty, offer_id)
       values ($1, $2, 'listing', $3, $4, 'Buyer', 'listing', $2, 24, 'confirmed', 'yes', now(), 12, $5)`,
      [match, deal, request, `demand:${request}`, offer]);
  };
  const stageOf = async (listing: string) => (await pg.queryPg<{ s: string; d: string | null; status: string; reason: string | null }>(
    `select bulk_listing_stage(id) as s, bulk_listing_deal_stage(id) as d, status, closed_reason as reason from crm_bulk_listings where id = $1`, [listing]))[0];
  const matchOf = async (match: string) => (await pg.queryPg<{ state: string; verdict: string | null; verdict_reason: string | null; reserved_qty: number | null; reserved_until: string | null }>(
    `select state, verdict, verdict_reason, reserved_qty::float8 as reserved_qty, reserved_until::text as reserved_until from crm_bulk_matches where id = $1`, [match]))[0];
  const move = (listing: string, offer: string, patch: Parameters<typeof offers.updateOffer>[2]) => offers.updateOffer(listing, offer, patch, user);

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_URL;
    pg = await import("../postgres");
    close = await import("./bulk-offer-close");
    offers = await import("./bulk-offers");
    mail = await import("./bulk-offer-mail");
    events = await import("./bulk-stage-events");
    await pg.queryPg("insert into crm_users (id, email, password_hash) values ($1, $2, 'x') on conflict (id) do nothing", [user, email]);
    for (const who of ["s", "b1", "b2"]) {
      await pg.queryPg("insert into crm_companies (id, name) values ($1, $2)", [id(`co${who}`), who === "s" ? SELLER : `Buyer ${who} ${run}`]);
      await pg.queryPg("insert into crm_people (id, full_name, email, company_id) values ($1, $2, $3, $4)",
        [id(`pe${who}`), who === "s" ? "Gareth Pryce" : `Sam ${who}`, `${who}.${run}@example.test`, id(`co${who}`)]);
    }
    await supply(id("sup1"), day(20));
    await supply(id("sup2"), day(20));
    for (const n of ["1", "2"]) {
      await pg.queryPg(
        `insert into crm_bulk_listings (id, kind, party, company_id, person_id, summary, quantity, status, spec)
         values ($1, 'demand', $2, $3, $4, 'Kona packs', '12 packs', 'open', '{"intent": "request"}')`,
        [id(`dem${n}`), `Buyer b${n} ${run}`, id(`cob${n}`), id(`peb${n}`)]);
      await pg.queryPg(
        `insert into crm_bulk_offers (id, bulk_listing_id, role, person_id, company_id, name, contact, stage, counterpart_id)
         values ($1, $2, 'counterparty', $3, $4, $5, $6, 'candidate', $7)`,
        [id(`of${n}`), id(`sup${n}`), id(`peb${n}`), id(`cob${n}`), `Buyer b${n} ${run}`, `b${n}.${run}@example.test`, id(`dem${n}`)]);
      await matched(id(`m${n}`), id(`sup${n}`), id(`dem${n}`), id(`of${n}`));
    }
  });

  afterAll(async () => {
    await pg.queryPg("delete from crm_bulk_matches where deal_id like $1", [`%_${run}`]);
    await pg.queryPg("delete from crm_bulk_listing_activity where bulk_listing_id like $1", [`%_${run}`]);
    await pg.queryPg("delete from crm_bulk_offers where bulk_listing_id like $1", [`%_${run}`]);
    await pg.queryPg("delete from crm_bulk_stage_events where subject_id like $1", [`%_${run}`]);
    await pg.queryPg("delete from crm_bulk_listings where id like $1", [`%_${run}`]);
    await pg.queryPg("delete from crm_people where id like $1", [`%_${run}`]);
    await pg.queryPg("delete from crm_companies where id like $1", [`%_${run}`]);
    await pg.queryPg("delete from crm_users where id = $1", [user]);
    await pg.pgPool.end();
  });

  it("reads the quote gate, the default last day and the margin from the stored rows", async () => {
    await move(id("sup1"), id("of1"), { terms: { amount: 2400, currency: "GBP", unit: "pack" } });
    const facts = await close.offerClose(id("of1"));
    expect(facts).toMatchObject({
      side: "buyer", gate: { ok: true, validUntil: day(20) }, expiresOn: day(20), quantity: 12,
      margin: { ok: true, currency: "GBP", perUnit: 400, quantity: 12, total: 4800, takeGbp: 4800, buyerTotal: 28800, approx: false },
    });
    // A seller-facing offer is never gated and shows no margin.
    await pg.queryPg(`insert into crm_bulk_offers (id, bulk_listing_id, role, name, stage) values ($1, $2, 'counterparty', 'Supplier', 'candidate')`, [id("ofs"), id("dem2")]);
    expect(await close.offerClose(id("ofs"))).toMatchObject({ side: "seller", gate: null, margin: null });
  });

  it("blocks an expired or unconfirmed seller quote, and makes no sheet then", async () => {
    await pg.queryPg(`update crm_bulk_listings set spec = spec || jsonb_build_object('seller_quote_valid_until', $2::text) where id = $1`, [id("sup2"), day(-9)]);
    const gated = await close.offerGate(id("of2"));
    expect(gated?.gate).toMatchObject({ ok: false, reason: expect.stringMatching(/^The seller's quote ran out on \d{1,2} [A-Z][a-z]{2}\. Ask them to confirm it\.$/) });
    await move(id("sup2"), id("of2"), { terms: { amount: 2400, currency: "GBP", unit: "pack" } });
    await expect(close.prepareOfferSheet(id("of2"), "fixed")).rejects.toThrow(/ran out/);
    await pg.queryPg(`update crm_bulk_listings set spec = spec || jsonb_build_object('seller_quote_valid_until', $2::text) where id = $1`, [id("sup2"), day(20)]);
    await pg.queryPg(`update crm_bulk_listing_fields set status = 'unverified' where bulk_listing_id = $1 and field_key = 'seller_price'`, [id("sup2")]);
    expect((await close.offerGate(id("of2")))?.gate).toMatchObject({ ok: false, reason: "The seller's price is not confirmed. Ask them to confirm it." });
    await pg.queryPg(`update crm_bulk_listing_fields set status = 'confirmed' where bulk_listing_id = $1 and field_key = 'seller_price'`, [id("sup2")]);
    expect((await close.offerGate(id("of2")))?.gate).toMatchObject({ ok: true });
  });

  it("drops the open draft and marks its sheet out of date when the price, quantity or terms change", async () => {
    const prepared = await close.prepareOfferSheet(id("of2"), "send");
    const docId = await close.storeOfferSheet(id("sup2"), id("of2"), prepared, user, "draft_y");
    await mail.setOpenDraft(id("of2"), "draft_y", "key-before");
    const state = async () => (await pg.queryPg<{ open: string | null; sheet: string | null; note: string; terms: string | null }>(
      `select o.data->>'open_draft_id' as open, o.data->>'open_sheet_doc_id' as sheet, d.note, o.data->'draft_terms'->>'draft_y' as terms
       from crm_bulk_offers o, crm_bulk_listing_documents d where o.id = $1 and d.id = $2`, [id("of2"), docId]))[0];
    expect(await state()).toMatchObject({ open: "draft_y", sheet: docId, terms: "key-before" });
    await move(id("sup2"), id("of2"), { nextStep: "Call Sam" }); // not a term: the draft stays
    expect((await state()).open).toBe("draft_y");
    await move(id("sup2"), id("of2"), { terms: { amount: 2200, currency: "GBP", unit: "pack", expires_on: day(20) } });
    const after = await state();
    expect(after).toMatchObject({ open: null, sheet: null, terms: "key-before" });
    expect(after.note).toMatch(/^Out of date, not sent: the offer's terms changed after it was made\./);
    // A quantity change alone does the same.
    await mail.setOpenDraft(id("of2"), "draft_z", "key-z");
    await move(id("sup2"), id("of2"), { paid: { quantity: 10 } });
    expect((await state()).open).toBeNull();
    await move(id("sup2"), id("of2"), { paid: { quantity: null }, terms: { amount: 2400, currency: "GBP", unit: "pack" } });
  });

  it("stores the send copy with the deal's documents, without the seller, and marks it sent with the email", async () => {
    const prepared = await close.prepareOfferSheet(id("of1"), "send");
    const text = prepared.sheet.rows.flat().join(" ") + prepared.sheet.text;
    for (const secret of [SELLER, "Gareth", "Mill Road", "2,000", "2000", "Leeds"]) {
      expect(text).not.toContain(secret);
    }
    expect(prepared.sheet.total).toEqual({ amount: 28800, currency: "GBP" });
    const docId = await close.storeOfferSheet(id("sup1"), id("of1"), prepared, user, "draft_x");
    const [doc] = await pg.queryPg<{ title: string; state: string; direction: string; doc_type: string; byte_size: number; file_name: string }>(
      `select title, state, direction, doc_type, byte_size::int as byte_size, file_name from crm_bulk_listing_documents where id = $1`, [docId]);
    expect(doc).toMatchObject({ state: "draft", direction: "prepared", doc_type: "Quote", file_name: `${prepared.sheet.reference}.xlsx` });
    expect(doc.byte_size).toBeGreaterThan(1000);
    expect(doc.title).toMatch(/^Price sheet \(sent copy\) PS-[0-9a-f]{8} for Buyer b1/);

    // The send: the offer moves to offered, the sheet is sent, History has both, and the match reserves 12 packs.
    expect(await mail.markOfferSent(id("of1"), user)).toEqual({ moved: true, stage: "offered", reservation: null });
    const [after] = await pg.queryPg<{ state: string; direction: string }>(`select state, direction from crm_bulk_listing_documents where id = $1`, [docId]);
    expect(after).toEqual({ state: "sent", direction: "sent" });
    const story = (await pg.queryPg<{ title: string }>(`select title from crm_bulk_listing_activity where bulk_listing_id = $1 and kind = 'document' order by id`, [id("sup1")])).map((r) => r.title);
    expect(story).toEqual([`Document added: ${doc.title}`, `Document sent: ${doc.title}`]);
    expect(await matchOf(id("m1"))).toMatchObject({ state: "offered", reserved_qty: 12 });
    expect((await matchOf(id("m1"))).reserved_until! <= day(20)).toBe(true);
    expect((await stageOf(id("sup1"))).s).toBe("Reserved");
  });

  it("walks candidate, offered, signed, invoiced, paid, complete: take from the margin, the request closed, the lot part sold", async () => {
    await move(id("sup1"), id("of1"), { stage: "signed" });
    await move(id("sup1"), id("of1"), { stage: "invoiced" });
    expect((await stageOf(id("sup1"))).d).toBe("Agreed");
    const margin = (await close.offerClose(id("of1")))!.margin!;
    expect(margin.ok).toBe(true);
    await move(id("sup1"), id("of1"), {
      stage: "paid", paid: { paid_on: day(0), paid_amount: 28800, paid_currency: "GBP", quantity: 12, take_gbp: margin.ok ? margin.takeGbp : null },
    });
    expect((await stageOf(id("sup1"))).s).toBe("Sold");
    await move(id("sup1"), id("of1"), { stage: "complete" });
    // 12 packs sold: all the request wanted, half the 24-pack lot, which stays open for the rest.
    expect(await stageOf(id("sup1"))).toMatchObject({ s: "Sold", d: "Delivered", status: "open", reason: null });
    expect((await pg.queryPg<{ title: string }>(`select title from crm_bulk_listing_activity where bulk_listing_id = $1 and offer_id = $2 and title like 'Part sold%'`, [id("sup1"), id("of1")]))
      .map((r) => r.title)).toEqual(["Part sold: 12 of 24"]);
    expect(await stageOf(id("dem1"))).toMatchObject({ s: "Closed", status: "closed", reason: "bought_from_us" });
    const [stored] = await pg.queryPg<{ take_gbp: number }>(`select take_gbp::float8 as take_gbp from crm_bulk_offers where id = $1`, [id("of1")]);
    expect(stored.take_gbp).toBe(4800);
    const path = (await events.listStageEvents("offer", id("of1"))).map((e) => e.to_stage);
    expect(path).toEqual(["candidate", "offered", "signed", "invoiced", "paid", "complete"]);
    // The match stays offered: a delivered deal is not a no.
    expect((await matchOf(id("m1"))).state).toBe("offered");
  });

  it("walks a second deal to lost: the match becomes a no with the reason, its reservation ends, the listing stays open", async () => {
    await move(id("sup2"), id("of2"), { stage: "offered" });
    expect(await matchOf(id("m2"))).toMatchObject({ state: "offered", reserved_qty: 12 });
    expect((await stageOf(id("sup2"))).s).toBe("Reserved");
    await move(id("sup2"), id("of2"), { stage: "lost", declinedReason: "Price: bought elsewhere" });
    expect(await matchOf(id("m2"))).toEqual({ state: "declined", verdict: "no", verdict_reason: "Price: bought elsewhere", reserved_qty: null, reserved_until: null });
    expect(await stageOf(id("sup2"))).toMatchObject({ d: "Lost", status: "open" });
    expect((await stageOf(id("sup2"))).s).not.toBe("Reserved");
    expect((await stageOf(id("dem2"))).status).toBe("open");
    const path = (await events.listStageEvents("offer", id("of2"))).map((e) => e.to_stage);
    expect(path).toEqual(["candidate", "offered", "lost"]);
  });
});
