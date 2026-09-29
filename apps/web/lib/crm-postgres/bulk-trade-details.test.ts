import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { todayInLondon } from "../bulk-trades";

// Runs only against a disposable database with migrations 003, 008 and 009 applied, e.g.
// BULK_TRADES_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/denchclaw
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
});
