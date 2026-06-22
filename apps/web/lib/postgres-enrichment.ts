import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from "pg";

const enrichmentPoolConfig: PoolConfig = process.env.ENRICHMENT_DATABASE_URL
  ? { connectionString: process.env.ENRICHMENT_DATABASE_URL }
  : { host: "/var/run/postgresql", database: "denchclaw_enrichment_copy" };

export const pgEnrichmentPool = new Pool({
  ...enrichmentPoolConfig,
  max: Number(process.env.ENRICHMENT_POSTGRES_POOL_MAX || 5),
  idleTimeoutMillis: 30_000,
});

export async function queryPgEnrichment<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const result = await pgEnrichmentPool.query<T>(sql, [...params]);
  return result.rows;
}

export type PgEnrichmentTransaction = Pick<PoolClient, "query">;

export async function withPgEnrichmentTransaction<T>(
  fn: (client: PgEnrichmentTransaction) => Promise<T>,
): Promise<T> {
  const client = await pgEnrichmentPool.connect();
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
