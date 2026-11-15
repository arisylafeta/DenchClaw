// Prints supplyMatchesV2 for every open supply listing, as JSON. Read only: run it with
// PGOPTIONS='-c default_transaction_read_only=on'. `ranking_compare.sh` bundles it once per code base.
import { supplyMatchesV2 } from "MODULE";
import { queryPg, pgPool } from "POSTGRES";

const ids = await queryPg<{ id: string; title: string }>("select id, title from crm_bulk_listing_supply_feed order by id");
const out: Record<string, unknown> = {};
for (const row of ids) {
  out[row.id] = { title: row.title, result: await supplyMatchesV2(row.id) };
}
await pgPool.end();
process.stdout.write(JSON.stringify(out));
