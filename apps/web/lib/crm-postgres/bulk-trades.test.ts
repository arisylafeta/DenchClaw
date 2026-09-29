import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
