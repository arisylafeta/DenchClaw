import { queryPg } from "../postgres";

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

export async function getTableColumns(tableName: string): Promise<Set<string>> {
  const rows = await queryPg<{ column_name: string }>(
    `select column_name
       from information_schema.columns
      where table_name = $1
        and table_schema = current_schema()`,
    [tableName],
  );
  return new Set(rows.map((row) => row.column_name));
}

/**
 * Compute how "full" each canonical column is across the entire backing table.
 * Returns a Map of column name -> ratio of non-null/non-empty rows [0, 1].
 */
export async function getColumnFillRates(tableName: string, columns: Set<string>): Promise<Map<string, number>> {
  const relevant = Array.from(columns);
  if (relevant.length === 0) return new Map();

  const fillExprs = relevant.map(
    (col) => `count(nullif(${quoteIdentifier(col)}::text, ''))::float / nullif(count(*)::float, 0) as ${quoteIdentifier(`${col}_fill_rate`)}`,
  );

  const rows = await queryPg<Record<string, number>>(
    `select count(*)::float as "_total", ${fillExprs.join(", ")} from ${quoteIdentifier(tableName)}`,
  );
  const row = rows[0] ?? {};
  const rates = new Map<string, number>();
  for (const col of relevant) {
    const value = row[`${col}_fill_rate`];
    rates.set(col, typeof value === "number" && Number.isFinite(value) ? value : 0);
  }
  return rates;
}
