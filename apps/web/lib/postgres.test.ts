import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const poolQuery = vi.fn();
const connect = vi.fn();
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalPostgresPoolMax = process.env.POSTGRES_POOL_MAX;

vi.mock("pg", () => ({
  Pool: vi.fn().mockImplementation(function PoolMock(config) {
    return { config, query: poolQuery, connect };
  }),
}));

describe("postgres", () => {
  beforeEach(() => {
    vi.resetModules();
    poolQuery.mockReset();
    connect.mockReset();
    delete process.env.DATABASE_URL;
    delete process.env.POSTGRES_POOL_MAX;
  });

  afterEach(() => {
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }

    if (originalPostgresPoolMax === undefined) {
      delete process.env.POSTGRES_POOL_MAX;
    } else {
      process.env.POSTGRES_POOL_MAX = originalPostgresPoolMax;
    }
  });

  it("uses the local denchclaw peer connection by default", async () => {
    const { queryPg } = await import("./postgres");
    const { Pool } = await import("pg");
    poolQuery.mockResolvedValue({ rows: [{ ok: 1 }] });

    const rows = await queryPg<{ ok: number }>("select 1 as ok");

    expect(Pool).toHaveBeenCalledWith({
      host: "/var/run/postgresql",
      database: "denchclaw",
      max: 10,
      idleTimeoutMillis: 30_000,
    });
    expect(rows).toEqual([{ ok: 1 }]);
    expect(poolQuery).toHaveBeenCalledWith("select 1 as ok", []);
  });

  it("honors DATABASE_URL when set", async () => {
    process.env.DATABASE_URL = "postgresql://user:pass@example.test:5432/denchclaw";

    await import("./postgres");
    const { Pool } = await import("pg");

    expect(Pool).toHaveBeenCalledWith({
      connectionString: "postgresql://user:pass@example.test:5432/denchclaw",
      max: 10,
      idleTimeoutMillis: 30_000,
    });
  });

  it("runs a transaction and releases the client", async () => {
    const client = { query: vi.fn(), release: vi.fn() };
    connect.mockResolvedValue(client);
    client.query.mockResolvedValue({ rows: [] });

    const { withPgTransaction } = await import("./postgres");
    await withPgTransaction(async (tx) => {
      await tx.query("select $1::int", [1]);
    });

    expect(client.query).toHaveBeenNthCalledWith(1, "begin");
    expect(client.query).toHaveBeenNthCalledWith(2, "select $1::int", [1]);
    expect(client.query).toHaveBeenLastCalledWith("commit");
    expect(client.release).toHaveBeenCalledOnce();
  });
});
