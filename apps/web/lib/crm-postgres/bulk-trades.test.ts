import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// Runs only against a disposable database: scripts/rebattery/crm-test-db.sh up prints the URL.
const TEST_URL = process.env.BULK_TRADES_TEST_DATABASE_URL;

describe.skipIf(!TEST_URL)("bulk trade writes", () => {
  let db: typeof import("./bulk-trades");
  let pg: typeof import("../postgres");
  let userId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_URL;
    pg = await import("../postgres");
    db = await import("./bulk-trades");
    const [user] = await pg.queryPg<{ id: string }>(
      `insert into crm_users (email, display_name, password_hash)
       values ('bulk-trades-test-' || gen_random_uuid() || '@example.test', 'Test Owner', 'x')
       returning id`,
    );
    userId = user.id;
  });

  afterAll(async () => {
    await pg.pgPool.end();
  });

  async function events(lotId: string) {
    return pg.queryPg<{ kind: string; changes: Record<string, unknown>; actor_user_id: string }>(
      "select kind, changes, actor_user_id from crm_bulk_trade_events where lot_id = $1 order by id",
      [lotId],
    );
  }

  it("works out the last touch from changes and buyers, and counts buyers and bids", async () => {
    const trade = await db.createBulkTrade({ title: "Synthetic touch trade" }, userId);
    const find = async () => (await db.listBulkTrades()).trades.find((t) => t.id === trade.id)!;
    const [{ today }] = await pg.queryPg<{ today: string }>("select to_char(now()::date, 'YYYY-MM-DD') as today");
    expect(await find()).toMatchObject({ last_touched: today, buyer_count: 0 }); // the creation is a touch
    await pg.queryPg(`insert into crm_bulk_trade_buyers (id, lot_id, name, last_touch_on) values ('btb_touch_' || gen_random_uuid(), $1, 'B', '2099-03-10')`, [trade.id]);
    expect(await find()).toMatchObject({ last_touched: "2099-03-10", buyer_count: 1, bid_count: 0 });
  });

  it("includes linked Gmail threads and unresolved buyer-company email activity in last touch", async () => {
    const trade = await db.createBulkTrade({ title: "Toyota Proace linkage regression" }, userId);
    const [company] = await pg.queryPg<{ id: string }>(
      "insert into crm_companies (id, name) values ('company_' || gen_random_uuid(), 'Synthetic STN Link Buyer') returning id");
    const [person] = await pg.queryPg<{ id: string }>(
      "insert into crm_people (id, full_name, email, company_id) values ('person_' || gen_random_uuid(), 'STN Contact', 'stn-link@example.test', $1) returning id", [company.id]);
    const [thread] = await pg.queryPg<{ id: string; gmail_thread_id: string }>(
      `insert into mail_thread (crm_visible, id, gmail_thread_id, subject, last_message_at, mailbox_owner_id)
       values (true, 'thread_' || gen_random_uuid(), gen_random_uuid()::text, 'STN collaboration', '2099-04-01', $1) returning id, gmail_thread_id`, [userId]);
    await pg.queryPg("insert into crm_bulk_trade_threads (thread_key, lot_id, verdict) values ($1, $2, 'trade')",
      [`gmail:${thread.gmail_thread_id}`, trade.id]);
    expect(await db.getBulkTrade(trade.id)).toMatchObject({ last_touched: "2099-04-01" });
    await pg.queryPg("delete from crm_bulk_trade_threads where lot_id = $1", [trade.id]);
    // STN was a named trade buyer with no resolved person_id or manually-maintained touch date.
    await pg.queryPg("insert into crm_bulk_trade_buyers (id, lot_id, name) values ('btb_' || gen_random_uuid(), $1, 'Synthetic STN Link Buyer')", [trade.id]);
    await pg.queryPg("insert into mail_thread_participant (thread_id, person_id) values ($1, $2)", [thread.id, person.id]);
    expect(await db.getBulkTrade(trade.id)).toMatchObject({ last_touched: "2099-04-01", has_buyer: true });
    const unrelated = await db.createBulkTrade({ title: "Unrelated trade" }, userId);
    expect((await db.getBulkTrade(unrelated.id))?.last_touched).not.toBe("2099-04-01");
    // The same company participates in both trades: explicit attribution must win over participants.
    await pg.queryPg("insert into crm_bulk_trade_buyers (id, lot_id, name, person_id) values ('btb_' || gen_random_uuid(), $1, 'Synthetic STN Link Buyer', $2)", [unrelated.id, person.id]);
    await pg.queryPg("insert into crm_bulk_trade_threads (thread_key, lot_id, verdict) values ($1, $2, 'trade')",
      [`gmail:${thread.gmail_thread_id}`, trade.id]);
    expect((await db.getBulkTrade(unrelated.id))?.last_touched).not.toBe("2099-04-01");
    expect((await db.getBulkTrade(trade.id))?.last_touched).toBe("2099-04-01");
    await pg.queryPg("update crm_bulk_trade_threads set lot_id = null, verdict = 'none' where thread_key = $1", [`gmail:${thread.gmail_thread_id}`]);
    expect((await db.getBulkTrade(trade.id))?.last_touched).not.toBe("2099-04-01");
    expect((await db.getBulkTrade(unrelated.id))?.last_touched).not.toBe("2099-04-01");
  });

  it("keeps origin independent from whether each counterparty is known", async () => {
    const trade = await db.createBulkTrade({ title: "Demand-origin trade", origin: "demand" }, userId);
    expect(trade).toMatchObject({ origin: "demand", has_seller: false, has_buyer: false });
    expect(await db.updateBulkTrade(trade.id, { seller_name: "Known supplier" }, userId))
      .toMatchObject({ origin: "demand", seller_name: "Known supplier", has_seller: true });
  });

  it("preserves manually curated sellers when the historical repair is replayed", async () => {
    const migration = readFileSync(new URL("./migrations/047_bulk_trade_seller_evidence.sql", import.meta.url), "utf8").split("-- Historical repair only.")[1].split("\n").slice(1).join("\n");
    await pg.queryPg(migration);
    const manual = await db.createBulkTrade({ title: "Manual seller replay regression", seller_name: "Curated supplier" }, userId);
    const supply = await db.createBulkTrade({ title: "Supply seller replay regression", seller_ref: "supply:curated", seller_name: "Curated supply" }, userId);
    const stock = await db.createBulkTrade({ title: "Stock seller replay regression", seller_ref: "stock:curated", seller_name: "Curated stock" }, userId);
    await pg.queryPg(migration);
    expect(await db.getBulkTrade(manual.id)).toMatchObject({ seller_name: "Curated supplier", seller_ref: null });
    expect(await db.getBulkTrade(supply.id)).toMatchObject({ seller_name: "Curated supply", seller_ref: "supply:curated" });
    expect(await db.getBulkTrade(stock.id)).toMatchObject({ seller_name: "Curated stock", seller_ref: "stock:curated" });
  });

  it("resolves gmail_thread and gmail_message evidence without incidental participants", async () => {
    const trade = await db.createBulkTrade({ title: "Explicit Gmail evidence regression" }, userId);
    const [thread] = await pg.queryPg<{ id: string; gmail_thread_id: string }>(
      `insert into mail_thread (crm_visible, id, gmail_thread_id, last_message_at)
       values (true, 'thread_' || gen_random_uuid(), gen_random_uuid()::text, '2099-05-01') returning id, gmail_thread_id`);
    await pg.queryPg(`insert into crm_bulk_trade_evidence_links (lot_id, evidence_kind, evidence_id, relationship)
      values ($1, 'gmail_thread', $2, 'supports')`, [trade.id, thread.gmail_thread_id]);
    expect((await db.getBulkTrade(trade.id))?.last_touched).toBe("2099-05-01");
    await pg.queryPg("delete from crm_bulk_trade_evidence_links where lot_id = $1", [trade.id]);
    const [message] = await pg.queryPg<{ gmail_message_id: string }>(
      `insert into mail_message (direction, transport, state, crm_visible, id, thread_id, gmail_message_id, sent_at)
       values ('inbound', 'gmail', 'received', true, 'message_' || gen_random_uuid(), $1, gen_random_uuid()::text, '2099-05-01') returning gmail_message_id`, [thread.id]);
    await pg.queryPg(`insert into crm_bulk_trade_evidence_links (lot_id, evidence_kind, evidence_id, relationship)
      values ($1, 'gmail_message', $2, 'supports')`, [trade.id, message.gmail_message_id]);
    expect((await db.getBulkTrade(trade.id))?.last_touched).toBe("2099-05-01");
  });

  it("uses current company names on trade rows and formats domain-only fallbacks", async () => {
    await pg.queryPg("insert into crm_companies (id, name) values ('seller_display_company', 'Canonical Supplier')");
    const trade = await db.createBulkTrade({ title: "Seller display regression",
      seller_ref: "company:seller_display_company", seller_name: "old-label.example.com" }, userId);
    expect(trade.seller_name).toBe("Canonical Supplier");
    await pg.queryPg("update crm_companies set name = 'Renamed Supplier' where id = 'seller_display_company'");
    expect((await db.getBulkTrade(trade.id))?.seller_name).toBe("Renamed Supplier");
    expect(await pg.queryPg(`select bulk_trade_seller_display(null, 'sales@north-battery.co.uk') as email,
      bulk_trade_seller_display(null, 'www.north-battery.com') as domain,
      bulk_trade_seller_display(null, 'North Battery Ltd') as name`))
      .toEqual([{ email: "North Battery", domain: "North Battery", name: "North Battery Ltd" }]);
  });

  it("puts a trade on hold remembering its stage, and clears the hold on resume", async () => {
    const trade = await db.createBulkTrade({ title: "Synthetic BESS portfolio", trade_stage: "With buyers" }, userId);
    const held = await db.updateBulkTrade(trade.id,
      { trade_stage: "On hold", hold_until: "2027-03-01", hold_reason: "Batteries stay on site until removal" }, userId);
    expect(held).toMatchObject({ trade_stage: "On hold", hold_until: "2027-03-01", hold_from_stage: "With buyers" });

    const changed = await db.updateBulkTrade(trade.id, { hold_until: "2027-04-01" }, userId);
    expect(changed).toMatchObject({ hold_until: "2027-04-01", hold_from_stage: "With buyers" });

    const resumed = await db.updateBulkTrade(trade.id, { trade_stage: "With buyers" }, userId);
    expect(resumed).toMatchObject({ trade_stage: "With buyers", hold_until: null, hold_reason: null, hold_from_stage: null });

    await expect(db.updateBulkTrade(trade.id, { hold_until: "2027-05-01" }, userId))
      .rejects.toMatchObject({ constraint: "crm_bulk_trade_lots_hold_check" });
  });

  it("creates a trade and logs who created it", async () => {
    const trade = await db.createBulkTrade(
      { title: "Synthetic eBS37", trade_stage: "With buyers", next_step: "Call supplier", next_step_due: "2026-09-28" },
      userId,
    );

    expect(trade).toMatchObject({ title: "Synthetic eBS37", trade_stage: "With buyers", next_step_due: "2026-09-28" });
    expect(await events(trade.id)).toMatchObject([{ kind: "trade_created", actor_user_id: userId }]);
    const [overview] = await pg.queryPg("select stage, trade_stage from crm_bulk_trade_overview where id = $1", [trade.id]);
    expect(overview).toEqual({ stage: "Sourced", trade_stage: "With buyers" });
  });

  it("logs only the fields that changed, with before and after", async () => {
    const trade = await db.createBulkTrade({ title: "Synthetic cells", next_step: "Send specs" }, userId);
    const updated = await db.updateBulkTrade(
      trade.id,
      { next_step: "Send specs", trade_stage: "Closing", owner_user_id: userId },
      userId,
    );

    expect(updated).toMatchObject({ trade_stage: "Closing", owner_name: "Test Owner" });
    const [, update] = await events(trade.id);
    expect(update).toMatchObject({
      kind: "trade_updated",
      changes: { trade_stage: ["Needs info", "Closing"], owner_user_id: [null, userId] },
    });
    expect(update.changes).not.toHaveProperty("next_step");
  });

  it("sets waiting_since when waiting moves to them and clears it when it moves back", async () => {
    const trade = await db.createBulkTrade({ title: "Synthetic waiting" }, userId);
    const waiting = await db.updateBulkTrade(trade.id, { waiting_on: "them" }, userId);
    expect(waiting?.waiting_since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const back = await db.updateBulkTrade(trade.id, { waiting_on: "us" }, userId);
    expect(back?.waiting_since).toBeNull();
  });

  it("writes nothing when the patch changes nothing, and nothing for unknown trades", async () => {
    const trade = await db.createBulkTrade({ title: "Synthetic unchanged" }, userId);
    await db.updateBulkTrade(trade.id, { title: "Synthetic unchanged" }, userId);
    expect(await events(trade.id)).toHaveLength(1);
    expect(await db.updateBulkTrade("bt_missing", { title: "x" }, userId)).toBeNull();
  });

  it("rolls back the trade change when the log insert fails", async () => {
    const trade = await db.createBulkTrade({ title: "Synthetic rollback" }, userId);
    await expect(db.updateBulkTrade(trade.id, { title: "Renamed" }, "00000000-0000-4000-8000-000000000000"))
      .rejects.toThrow();
    const [row] = await pg.queryPg("select title from crm_bulk_trade_lots where id = $1", [trade.id]);
    expect(row).toEqual({ title: "Synthetic rollback" });
  });
});
