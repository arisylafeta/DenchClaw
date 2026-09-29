import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { todayInLondon } from "../bulk-trades";

// Runs only against a disposable database: scripts/rebattery/crm-test-db.sh up prints the URL.
const TEST_URL = process.env.BULK_TRADES_TEST_DATABASE_URL;

describe.skipIf(!TEST_URL)("bulk trade detail writes", () => {
  let db: typeof import("./bulk-trade-details");
  let trades: typeof import("./bulk-trades");
  let pg: typeof import("../postgres");
  let userId: string;
  let lotId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_URL;
    pg = await import("../postgres");
    trades = await import("./bulk-trades");
    db = await import("./bulk-trade-details");
    const [user] = await pg.queryPg<{ id: string }>(
      `insert into crm_users (email, display_name, password_hash)
       values ('bulk-trades-test-' || gen_random_uuid() || '@example.test', 'Test Owner', 'x')
       returning id`,
    );
    userId = user.id;
    lotId = (await trades.createBulkTrade({ title: "Synthetic eBS37", trade_kind: "packs" }, userId)).id;
  });

  afterAll(async () => {
    await pg.pgPool.end();
  });

  const events = (buyerId?: string) =>
    pg.queryPg<{ kind: string; changes: Record<string, unknown>; buyer_id: string | null }>(
      `select kind, changes, buyer_id from crm_bulk_trade_events
       where lot_id = $1 and ($2::text is null or buyer_id = $2) order by id`,
      [lotId, buyerId ?? null],
    );

  it("logs each buyer status change and bid with the buyer", async () => {
    const buyer = await db.addBuyer(lotId, { name: "Synthetic Buyer", wants: "36-pack pilot" }, userId);
    expect(buyer).toMatchObject({ status: "To contact", latest_bid: null });

    const sent = await db.updateBuyer(lotId, buyer!.id, { status: "Teaser sent" }, userId);
    expect(sent).toMatchObject({ status: "Teaser sent", last_touch_on: todayInLondon() });

    const bid = await db.addBid(lotId, buyer!.id, {
      amount: 22, unit: "kWh", currency: "EUR", firmness: "indicative",
      delivery_terms: "EXW", payment_terms: null, expires_on: "2026-10-15",
    }, userId);
    expect(bid).toMatchObject({ status: "Bid in", latest_bid: { amount: "22", unit: "kWh", expires_on: "2026-10-15" } });

    expect((await events(buyer!.id)).map((event) => event.kind))
      .toEqual(["buyer_added", "buyer_updated", "bid_added", "buyer_updated"]);
    const other = await db.addBuyer(lotId, { name: "Touched earlier", last_touch_on: "2026-09-01" }, userId);
    await db.addBid(lotId, other!.id, {
      amount: 5, unit: "pack", currency: "EUR", firmness: "firm", delivery_terms: null, payment_terms: null, expires_on: null,
    }, userId);
    expect((await events(other!.id)).at(-1)!.changes).toEqual({
      status: ["To contact", "Bid in"], last_touch_on: ["2026-09-01", todayInLondon()],
    });
  });

  it("rejects a buyer from another trade", async () => {
    const other = await trades.createBulkTrade({ title: "Other synthetic" }, userId);
    const buyer = await db.addBuyer(other.id, { name: "Elsewhere" }, userId);
    expect(await db.updateBuyer(lotId, buyer!.id, { status: "Won" }, userId)).toBeNull();
  });

  it("gives new fields the template's buyer visibility and refuses keys outside the template", async () => {
    const price = await db.setField(lotId, "seller_price", { value: "€20–25/kWh net", status: "unverified" }, userId);
    expect(price).toMatchObject({ visibility: "never", status: "unverified" });
    expect(await db.setField(lotId, "weight", { value: "3 t" }, userId)).toBe("unknown_field");
  });

  it("settles a conflict with the chosen claim and keeps the dropped one in the log", async () => {
    await db.setField(lotId, "quantity", { value: "161 + 9 incomplete", status: "conflict", source_label: "Gmail · 11 Sep" }, userId);
    await pg.queryPg(
      `update crm_bulk_trade_fields set alternatives = $2 where lot_id = $1 and field_key = 'quantity'`,
      [lotId, JSON.stringify([{ value: "about 200", source_label: "Call · 18 Sep", source_url: null, source_date: null }])],
    );

    const settled = await db.resolveConflict(lotId, "quantity", -1, userId);
    expect(settled).toMatchObject({ value: "161 + 9 incomplete", status: "confirmed", alternatives: [] });
    const last = (await events()).at(-1)!;
    expect(JSON.stringify(last.changes)).toContain("about 200");
  });

  it("shows the latest campaign email for this trade's listing on a linked buyer", async () => {
    const suffix = Date.now().toString(36);
    const [person] = await pg.queryPg<{ id: string }>(
      `insert into crm_people (id, full_name, email) values ('p_test_' || $1, 'Tess Buyer', 'tess-' || $1 || '@example.test') returning id`,
      [suffix],
    );
    await pg.queryPg(`insert into campaigns (id, campaign_name) values ('c_test_' || $1, 'Synthetic teaser')`, [suffix]);
    await pg.queryPg(
      `insert into crm_campaign_sends (id, campaign_id, person_id, listing_id, auction_url, recipient_email, state,
         accepted_at, delivered_at, provider_opened_at)
       values ('s_test_' || $1, 'c_test_' || $1, $2, 'lst_' || $1, 'https://example.test/a', 'tess-' || $1 || '@example.test',
         'accepted', '2026-09-24T09:00:00Z', '2026-09-24T09:01:00Z', '2026-09-25T08:00:00Z')`,
      [suffix, person.id],
    );
    const lot = await trades.createBulkTrade({ title: "Tracked synthetic", listing_id: `lst_${suffix}` }, userId);
    const buyer = await db.addBuyer(lot.id, { name: "Tess Buyer", person_id: person.id }, userId);

    expect(buyer).toMatchObject({
      person_email: `tess-${suffix}@example.test`,
      email_tracking: { campaign: "Synthetic teaser", clicked_at: null },
    });
    expect(buyer!.email_tracking!.opened_at).toBeTruthy();

    const other = await trades.createBulkTrade({ title: "Different listing", listing_id: "lst_other" }, userId);
    expect((await db.addBuyer(other.id, { name: "Tess Buyer", person_id: person.id }, userId))!.email_tracking).toBeNull();
  });

  it("records contacts, files and email drafts in the log, and finds CRM people", async () => {
    const contact = await db.addContact(lotId, { name: "Sam Supplier", email: "sam@example.test" }, userId);
    await db.updateContact(lotId, contact!.id, { phone: "+44 7700 900123" }, userId);
    expect(await db.removeContact(lotId, contact!.id, userId)).toBe(true);

    const file = await db.recordFile(
      lotId,
      { file_name: "stock.xlsx", file_type: "Stock list", content_type: null, content: Buffer.from("0123456789") },
      { file_type: "Stock list", visibility: "never" },
      userId,
    );
    expect(file).toMatchObject({ visibility: "never", byte_size: 10 });
    expect(await db.updateFile(lotId, file!.id, { visibility: "teaser" }, userId)).toMatchObject({ visibility: "teaser" });
    await db.logEmailDraft(lotId, { to: ["sam@example.test"], subject: "eBS37", draft_id: "r1" }, userId);

    const added = (await events()).find((event) => event.kind === "file_added")!;
    expect(added.changes).toMatchObject({ visibility: "never", source_label: null, byte_size: 10 });
    expect((await db.getFileForDownload(lotId, file!.id))!.content.toString()).toBe("0123456789");
    const kinds = (await events()).map((event) => event.kind);
    expect(kinds).toEqual(expect.arrayContaining(["contact_added", "contact_updated", "contact_removed", "file_added", "file_updated", "email_drafted"]));
    expect((await db.searchPeople("Tess"))[0]).toMatchObject({ name: "Tess Buyer", opted_out: false });
    await pg.queryPg("insert into crm_companies (id, name) values ('c_search_test', 'Searchable Storage GmbH') on conflict do nothing");
    expect((await db.searchCompanies("searchable"))[0]).toMatchObject({ name: "Searchable Storage GmbH", people: 0 });
    expect(await db.searchCompanies("100%_")).toEqual([]);
    await expect(pg.queryPg("delete from crm_bulk_trade_events where lot_id = $1", [lotId])).rejects.toThrow(/append-only/);
  });

  it("counts a person's click on a tracked link against the buyer, not a scanner's", async () => {
    const buyer = await db.addBuyer(lotId, { name: "Link Buyer" }, userId);
    const tokens = await db.createTrackedLinks(lotId, buyer!.id, "link@example.test", ["https://example.test/auction"], userId);
    const token = tokens.get("https://example.test/auction")!;

    expect(await db.followTrackedLink(token, false)).toBe("https://example.test/auction");
    expect((await db.getTradeDetail(lotId))!.buyers.find((row) => row.id === buyer!.id)!.link_clicked_at).toBeNull();

    await db.followTrackedLink(token, true);
    const after = (await db.getTradeDetail(lotId))!.buyers.find((row) => row.id === buyer!.id)!;
    expect(after.link_clicked_at).toBeTruthy();
    expect((await events(buyer!.id)).map((event) => event.kind)).toContain("link_clicked");
    expect(await db.followTrackedLink("NoSuchTokenNoSuchToken", true)).toBeNull();
  });

  it("queues concurrent first writes to the same field instead of failing", async () => {
    const results = await Promise.all([
      db.setField(lotId, "chemistry", { value: "NMC" }, userId),
      db.setField(lotId, "chemistry", { value: "NMC 622" }, userId),
    ]);
    expect(results.every((result) => result && typeof result === "object")).toBe(true);
  });
});

