import { describe, expect, it, vi } from "vitest";

describe("postgres pool under Vitest", () => {
  it("refuses the live CRM when no disposable database URL is set", async () => {
    vi.resetModules();
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const pg = await import("./postgres");
      await expect(pg.queryPg("select current_database()")).rejects.toThrow();
      await pg.pgPool.end();
    } finally {
      if (saved !== undefined) process.env.DATABASE_URL = saved;
    }
  });

  it("refuses a URL on the default port", async () => {
    vi.resetModules();
    const saved = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://postgres@127.0.0.1:5432/denchclaw";
    try {
      const pg = await import("./postgres");
      await expect(pg.queryPg("select current_database()")).rejects.toThrow();
      await pg.pgPool.end();
    } finally {
      if (saved === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = saved;
    }
  });
});
