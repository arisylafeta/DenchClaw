import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Runs only against a disposable database: scripts/rebattery/crm-test-db.sh up prints the URL.
const TEST_URL = process.env.BULK_TRADES_TEST_DATABASE_URL;

describe.skipIf(!TEST_URL)("completeListingNext", () => {
  let pg: typeof import("../postgres");
  let next: typeof import("./bulk-listing-next");
  const listing = async () => (await pg.queryPg<{ next_action: string | null; next_due: string | null; owner: string | null }>(
    "select next_action, to_char(next_due, 'YYYY-MM-DD') next_due, context->>'owner' owner from crm_bulk_listings where id = 'nxt_1'"))[0];

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_URL;
    pg = await import("../postgres");
    next = await import("./bulk-listing-next");
    await pg.queryPg(`delete from crm_bulk_listings where id like 'nxt_%';
      insert into crm_bulk_listings (id, kind, party, summary, status, spec, next_action, next_due)
      values ('nxt_1', 'supply', 'Seller', 'Lot', 'open', '{}', 'Ask David', '2026-11-02')`);
  });
  afterAll(async () => {
    await pg.queryPg("delete from crm_bulk_listings where id like 'nxt_%'");
    await pg.pgPool.end();
  });

  it("logs the done action in Story and sets the next one with its driver", async () => {
    expect(await next.completeListingNext("nxt_1", { done: "Ask David", next_action: "Send terms", next_due: "2026-11-18", owner: "Sean" }, null)).toBe("ok");
    expect(await listing()).toEqual({ next_action: "Send terms", next_due: "2026-11-18", owner: "Sean" });
    const [story] = await pg.queryPg<{ kind: string; title: string; data: Record<string, unknown> }>(
      "select kind, title, data from crm_bulk_listing_activity where bulk_listing_id = 'nxt_1' order by id desc limit 1");
    expect(story).toMatchObject({ kind: "note", title: "Done: Ask David", data: { next_done: "Ask David", was_due: "2026-11-02", next_action: "Send terms" } });
  });

  it("does nothing when the action changed since it was seen (retry, other tab)", async () => {
    const before = (await pg.queryPg("select count(*)::int n from crm_bulk_listing_activity where bulk_listing_id = 'nxt_1'"))[0].n;
    expect(await next.completeListingNext("nxt_1", { done: "Ask David", next_action: "Again", next_due: null }, null)).toBe("conflict");
    expect((await pg.queryPg("select count(*)::int n from crm_bulk_listing_activity where bulk_listing_id = 'nxt_1'"))[0].n).toBe(before);
    expect((await listing()).next_action).toBe("Send terms");
  });

  it("clears the action and its date when there is no next one, and keeps the driver", async () => {
    expect(await next.completeListingNext("nxt_1", { done: "Send terms", next_action: null, next_due: "2026-11-20" }, null)).toBe("ok");
    expect(await listing()).toEqual({ next_action: null, next_due: null, owner: "Sean" });
  });

  it("sets action, date and driver in one statement", async () => {
    expect(await next.setListingNext("nxt_1", { next_action: "Call", next_due: "2026-11-19", owner: "Alex" })).toBe(true);
    expect(await listing()).toEqual({ next_action: "Call", next_due: "2026-11-19", owner: "Alex" });
  });

  it("returns missing for a missing listing and writes nothing", async () => {
    expect(await next.completeListingNext("nxt_missing", { done: "x", next_action: null, next_due: null }, null)).toBe("missing");
    expect((await pg.queryPg("select 1 from crm_bulk_listing_activity where bulk_listing_id = 'nxt_missing'")).length).toBe(0);
  });
});
