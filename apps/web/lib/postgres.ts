import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from "pg";

// Tests must never reach the live CRM: under Vitest only a disposable TCP database on a non-default port is allowed
// (scripts/rebattery/crm-test-db.sh). Anything else gets a pool that cannot connect, so imports still work.
function isDisposableTestUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return Boolean(parsed.port) && parsed.port !== "5432";
  } catch {
    return false;
  }
}

const refuseLiveInTests = Boolean(process.env.VITEST) && !isDisposableTestUrl(process.env.DATABASE_URL);

const poolConfig: PoolConfig = refuseLiveInTests
  ? { host: "/nonexistent/live-crm-refused-in-tests", database: "refused_in_tests" }
  : process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : { host: "/var/run/postgresql", database: "denchclaw" };

export const pgPool = new Pool({
  ...poolConfig,
  max: Number(process.env.POSTGRES_POOL_MAX || 10),
  idleTimeoutMillis: 30_000,
});

export async function queryPg<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const result = await pgPool.query<T>(sql, [...params]);
  return result.rows;
}

export type PgTransaction = Pick<PoolClient, "query">;

export async function withPgTransaction<T>(
  fn: (client: PgTransaction) => Promise<T>,
): Promise<T> {
  const client = await pgPool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}
