import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Runs only against a disposable database: scripts/rebattery/crm-test-db.sh up prints the URL.
const TEST_URL = process.env.BULK_TRADES_TEST_DATABASE_URL;
const TODAY = "2026-11-15";

describe("buyerLinesEnabled", () => {
  it("is on unless MATCH_BUYER_LINES is off", async () => {
    const { buyerLinesEnabled } = await import("./supply-matches-v2");
    const saved = process.env.MATCH_BUYER_LINES;
    try {
      delete process.env.MATCH_BUYER_LINES;
      expect(buyerLinesEnabled()).toBe(true);
      process.env.MATCH_BUYER_LINES = "on";
      expect(buyerLinesEnabled()).toBe(true);
      process.env.MATCH_BUYER_LINES = " OFF ";
      expect(buyerLinesEnabled()).toBe(false);
    } finally {
      if (saved === undefined) { delete process.env.MATCH_BUYER_LINES; } else { process.env.MATCH_BUYER_LINES = saved; }
    }
  });
});

describe.skipIf(!TEST_URL)("supply matches pool and lines", () => {
  let pg: typeof import("../postgres");
  let v2: typeof import("./supply-matches-v2");
  const run = Math.random().toString(36).slice(2, 8);
  const id = (value: string) => `${value}_${run}`;

  const addLine = (company: string, kind: string, key: string, extra: { expires?: string | null; reason?: string } = {}) =>
    pg.queryPg(
      `insert into buyer_interest (id, company_id, kind, ownership, product_key, product_key_level, first_seen, last_seen, expires_on, decline_reason, saved_search_id)
       values ($1, $2, $3, $7, $4, $8, '2026-10-01', '2026-10-01', $5::date, $6, $9)`,
      [`${company}_${kind}_${key}_${run}`, id(company), kind, key, extra.expires ?? null, extra.reason ?? null,
        ["standing", "interest", "inferred"].includes(kind) ? "mastered" : "synced", key.startsWith("part:") ? "part" : "broad",
        ["standing", "interest", "inferred"].includes(kind) ? null : `test:${company}_${run}`]);

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_URL;
    pg = await import("../postgres");
    v2 = await import("./supply-matches-v2");
    for (const company of ["boxed", "linesonly", "expired", "declined", "none", "excluded"]) {
      await pg.queryPg(`insert into crm_companies (id, name) values ($1, $1)`, [id(company)]);
    }
    await pg.queryPg(`update crm_companies set buyer_profile = '{"chemistries":["NMC"]}'::jsonb where id = $1`, [id("boxed")]);
    await pg.queryPg(`update crm_companies set buyer_exclusion_reason = 'test' where id = $1`, [id("excluded")]);
    await addLine("linesonly", "saved_search", "broad:nmc-packs");
    await addLine("expired", "standing", "broad:nmc-packs", { expires: "2026-11-01" });
    await addLine("declined", "declined", "part:SU001B5189", { reason: "price" });
    await addLine("excluded", "ask", "broad:nmc-packs");
    await addLine("boxed", "bought", "part:SU001B5189");
  });

  afterAll(async () => {
    if (!pg) {return;}
    await pg.queryPg(`delete from buyer_interest where company_id like $1`, [`%_${run}`]);
    // Deleting a company trips the frozen Bulk Trades party trigger; the disposable database drops with the container.
    await pg.pgPool.end();
  });

  const pool = async (withLines: boolean) => {
    const rows = withLines
      ? await pg.queryPg<{ id: string }>(v2.buyerPoolSql(true), [null, TODAY])
      : await pg.queryPg<{ id: string }>(v2.buyerPoolSql(false), [null]);
    return rows.map((row) => row.id).filter((value) => value.endsWith(`_${run}`)).toSorted();
  };

  it("adds companies with a current line to the pool, and no one else", async () => {
    expect(await pool(true)).toEqual([id("boxed"), id("linesonly")]);
  });

  it("with lines off, the pool is the buy box alone", async () => {
    expect(await pool(false)).toEqual([id("boxed")]);
  });

  it("reads every current line for the pool in one query, leaving out expired ones", async () => {
    const lines = await v2.loadBuyerLines([id("boxed"), id("linesonly"), id("expired"), id("declined")], TODAY);
    expect([...lines.keys()].toSorted()).toEqual([id("boxed"), id("declined"), id("linesonly")]);
    expect(lines.get(id("declined"))?.[0]).toMatchObject({ kind: "declined", productKey: "part:SU001B5189", declineReason: "price" });
    expect(lines.get(id("boxed"))?.[0]).toMatchObject({ kind: "bought", firstSeen: "2026-10-01", expiresOn: null });
    expect((await v2.loadBuyerLines([], TODAY)).size).toBe(0);
  });

  it("the line read uses the company_id index", async () => {
    const plan = await pg.pgPool.connect();
    try {
      await plan.query("begin");
      await plan.query("set local enable_seqscan = off");
      const result = await plan.query(
        `explain select company_id from buyer_interest where company_id = any($1::text[]) and (expires_on is null or expires_on >= $2::date)`,
        [[id("boxed")], TODAY]);
      expect(result.rows.map((row) => row["QUERY PLAN"]).join("\n")).toMatch(/buyer_interest_company_idx/);
    } finally {
      await plan.query("rollback");
      plan.release();
    }
  });
});
