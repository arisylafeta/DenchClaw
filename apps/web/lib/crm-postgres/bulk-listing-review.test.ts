import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Runs only against a disposable database: scripts/rebattery/crm-test-db.sh up prints the URL.
const TEST_URL = process.env.BULK_TRADES_TEST_DATABASE_URL;

describe.skipIf(!TEST_URL)("reviewListing", () => {
  let pg: typeof import("../postgres");
  let review: typeof import("./bulk-listing-review");
  const read = async (id: string) => (await pg.queryPg<{ status: string; closed_reason: string | null; state: string; next_action: string | null }>(
    "select status, closed_reason, context->'review'->>'state' state, next_action from crm_bulk_listings where id = $1", [id]))[0];

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_URL;
    pg = await import("../postgres");
    review = await import("./bulk-listing-review");
    await pg.queryPg(`delete from crm_bulk_listings where id like 'rev_%';
      insert into crm_bulk_listings (id, kind, party, summary, status, spec, context, next_action, next_due) values
        ('rev_a', 'demand', 'Buyer', 'Packs', 'qualifying', '{"intent": "request"}', '{"review": {"state": "needs_review"}}', 'Review: confirm', '2026-11-17'),
        ('rev_b', 'demand', 'Buyer', 'Packs', 'qualifying', '{"intent": "request"}', '{"review": {"state": "needs_review"}}', 'Review: confirm', '2026-11-17'),
        ('rev_c', 'demand', 'Buyer', 'Packs', 'qualifying', '{"intent": "request"}', '{}', null, null)`);
  });
  afterAll(async () => {
    await pg.queryPg("delete from crm_bulk_listings where id like 'rev_%'");
    await pg.pgPool.end();
  });

  it("approve keeps it open and clears the flag; a second decision is refused", async () => {
    expect(await review.reviewListing("rev_a", "approve", null)).toBe("ok");
    expect(await read("rev_a")).toEqual({ status: "qualifying", closed_reason: null, state: "approved", next_action: "Review: confirm" });
    expect(await review.reviewListing("rev_a", "reject", null)).toBe("not_pending");
  });

  it("reject closes it as not a fit and clears the action", async () => {
    expect(await review.reviewListing("rev_b", "reject", null)).toBe("ok");
    expect(await read("rev_b")).toEqual({ status: "closed", closed_reason: "not_a_fit", state: "rejected", next_action: null });
  });

  it("refuses a listing nobody asked to review, and a missing one", async () => {
    expect(await review.reviewListing("rev_c", "approve", null)).toBe("not_pending");
    expect(await review.reviewListing("rev_missing", "approve", null)).toBe("missing");
  });
});
