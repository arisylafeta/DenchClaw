import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from "pg";

const poolConfig: PoolConfig = process.env.DATABASE_URL
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
