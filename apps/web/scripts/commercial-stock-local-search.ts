/**
 * Local twin of POST /api/commercial-buyer/stock for search evaluation (REB-577): reads one JSON filter object per
 * stdin line, answers each with the same response shape from the local CRM database. Read only.
 *   echo '{"model":"ID3"}' | pnpm exec tsx scripts/commercial-stock-local-search.ts
 */
import { createInterface } from "node:readline";
import { aggregateStock, interpretFilters, searchRows, suggestModels, supplierToken, type StockFilters } from "../lib/commercial-stock";
import { liveStock } from "../lib/crm-postgres/commercial-stock";
import { pgPool } from "../lib/postgres";

async function main() {
  const all = await liveStock();
  for await (const line of createInterface({ input: process.stdin })) {
    if (!line.trim()) continue;
    const filters = JSON.parse(line) as StockFilters & { scope?: string };
    const { rows, matchedOn } = searchRows(all, filters);
    const groups = aggregateStock(rows, (id) => supplierToken(id, filters.scope ?? "local", "local-eval-key-0000000000000000"));
    process.stdout.write(`${JSON.stringify({
      groups: groups.slice(0, filters.limit ?? 20), totalGroups: groups.length, totalUnits: groups.reduce((sum, group) => sum + group.units, 0),
      interpreted: { ...interpretFilters(filters), ...(matchedOn === "fits" ? { matchedOn: "vehicles the pack fits" } : {}) }, ...(groups.length ? {} : { suggestions: suggestModels(all, filters) }),
    })}\n`);
  }
  await pgPool.end();
}

void main();
