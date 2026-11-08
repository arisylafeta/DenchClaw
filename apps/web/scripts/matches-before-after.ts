/**
 * Read-only before/after check for the Matches tabs. `snapshot` runs the request matcher for every open or
 * qualifying request, and the supply matcher's live-ask rows for every open or qualifying supply listing, on the
 * local CRM database, and prints one JSON snapshot. `diff` compares two snapshots as Markdown. Every connection is
 * set read-only, so nothing here can write. Marketplace listings come from the platform database and are left out
 * unless its environment is set.
 *
 *   node --conditions=react-server --import tsx scripts/matches-before-after.ts snapshot > before.json
 *   node --import tsx scripts/matches-before-after.ts diff before.json after.json > report.md
 */
import { readFileSync } from "node:fs";
import type { MatchRow } from "../lib/matches-types";

type Row = Pick<MatchRow, "key" | "name" | "detail" | "reason" | "checks" | "tags"> & {
  holds?: string | null; source?: string | null; fit?: { label: string; state: string }[]; stockTitle?: string | null;
};
type Listing = { id: string; title: string; status: string; rows: Row[]; considered: number; errors: string[] };
type Snapshot = { at: string; demand: Listing[]; supply: Listing[] };

async function snapshot(): Promise<Snapshot> {
  // node-postgres reads PGOPTIONS for every new connection, before any query runs.
  process.env.PGOPTIONS = "-c default_transaction_read_only=on";
  const { pgPool, queryPg } = await import("../lib/postgres");
  const [mode] = await queryPg<{ ro: string }>("select current_setting('default_transaction_read_only') as ro");
  if (mode?.ro !== "on") {
    throw new Error("The connection is not read-only; refusing to run.");
  }
  const { demandMatchesV2 } = await import("../lib/crm-postgres/demand-matches-v2");
  const { supplyMatchesV2 } = await import("../lib/crm-postgres/supply-matches-v2");
  const listings = await queryPg<{ id: string; kind: string; status: string; title: string }>(
    `select id, kind, status, coalesce(nullif(spec->>'listing_title', ''), nullif(context->>'listing_title', ''), summary, id) as title
     from crm_bulk_listings where status in ('open', 'qualifying') order by kind, id`);
  const out: Snapshot = { at: new Date().toISOString(), demand: [], supply: [] };
  for (const listing of listings) {
    const result = listing.kind === "demand" ? await demandMatchesV2(listing.id) : await supplyMatchesV2(listing.id);
    if (!result) {
      continue;
    }
    const rows = (listing.kind === "demand" ? result.rows : result.rows.filter((row) => row.tags.includes("live ask")))
      .map((row) => ({
        key: row.key, name: row.name, detail: row.detail, reason: row.reason, checks: row.checks, tags: row.tags,
        ...("holds" in row ? { holds: (row as Row).holds ?? null, source: (row as Row).source ?? null, fit: (row as Row).fit ?? [] } : {}),
      }));
    const stockIds = rows.filter((row) => row.key.startsWith("stock:")).map((row) => row.key.slice(6));
    const titles = stockIds.length
      ? new Map((await queryPg<{ id: string; title: string }>(`select id, title from crm_stock_opportunities where id = any($1::text[])`, [stockIds]))
        .map((row) => [row.id, row.title]))
      : new Map<string, string>();
    const entry: Listing = {
      id: listing.id, title: listing.title, status: listing.status, considered: result.considered, errors: result.errors,
      rows: rows.map((row) => (row.key.startsWith("stock:") ? { ...row, stockTitle: titles.get(row.key.slice(6)) ?? null } : row)),
    };
    (listing.kind === "demand" ? out.demand : out.supply).push(entry);
  }
  await pgPool.end();
  return out;
}

const JUNK = /\b(12 ?v|agm|starter|start[- ]stop|lead[- ]acid|efb|48 ?v|auxiliary|aux)\b/i;
/** The quantity a row states, as a number or "not stated", so "1 units" and "1 pack" read the same. */
const quantityOf = (row: Row) => {
  const text = row.holds ?? row.detail ?? "";
  // The quantity is its own " · " part of the line: "1 pack", "12,400 cells", "quantity not stated".
  for (const part of text.split(" · ")) {
    if (/^quantity not stated$/i.test(part.trim())) return "not stated";
    const hit = part.trim().match(/^([\d,]+) (?:units?|cells?|packs?|modules?|systems?)$/i);
    if (hit) return hit[1].replace(/,/g, "");
  }
  return "?";
};
const label = (row: Row) => `${row.name} · ${row.stockTitle ?? row.holds ?? row.reason}`.replace(/\|/g, "/");
const marks = (row: Row) => (row.fit ?? []).map((mark) => `${{ fits: "✓", close: "≈", unstated: "?", misses: "✗" }[mark.state] ?? mark.state} ${mark.label}`).join(", ");

function diff(before: Snapshot, after: Snapshot): string {
  const lines: string[] = [];
  const section = (name: string, a: Listing[], b: Listing[], showMarks: boolean) => {
    const byId = new Map(a.map((listing) => [listing.id, listing]));
    let added = 0;
    let removed = 0;
    let changed = 0;
    const body: string[] = [];
    for (const listing of b) {
      const old = byId.get(listing.id);
      const oldRows = new Map((old?.rows ?? []).map((row) => [row.key, row]));
      const newRows = new Map(listing.rows.map((row) => [row.key, row]));
      const plus = listing.rows.filter((row) => !oldRows.has(row.key));
      const minus = (old?.rows ?? []).filter((row) => !newRows.has(row.key));
      const kept = listing.rows.filter((row) => oldRows.has(row.key));
      const qty = kept.filter((row) => quantityOf(row) !== quantityOf(oldRows.get(row.key)!));
      const checkChanges = kept.filter((row) => JSON.stringify(row.checks) !== JSON.stringify(oldRows.get(row.key)!.checks));
      added += plus.length;
      removed += minus.length;
      changed += qty.length;
      body.push(`### ${listing.title}`, "", `\`${listing.id}\` (${listing.status}) · before ${old?.rows.length ?? 0} rows, after ${listing.rows.length} · added ${plus.length}, removed ${minus.length}, quantity changed ${qty.length}${checkChanges.length ? `, checks changed ${checkChanges.length}` : ""}`, "");
      if (listing.errors.length) {
        body.push(`Errors: ${listing.errors.join("; ")}`, "");
      }
      for (const row of plus) {
        const junk = JUNK.test(`${row.stockTitle ?? ""} ${row.holds ?? ""} ${row.reason}`);
        body.push(`- Added: ${label(row)} · ${quantityOf(row)}${showMarks && row.fit?.length ? ` · ${marks(row)}` : ""}${junk ? " · **looks like junk**" : ""}`);
      }
      for (const row of minus) {
        body.push(`- Removed: ${label(row)} (was: ${row.reason}${row.detail ? ` · ${row.detail}` : ""})`);
      }
      for (const row of qty.slice(0, 8)) {
        body.push(`- Quantity: ${label(row)}: "${quantityOf(oldRows.get(row.key)!)}" → "${quantityOf(row)}"`);
      }
      if (qty.length > 8) {
        body.push(`- …and ${qty.length - 8} more quantity changes of the same kind`);
      }
      if (name === "Supply listings") {
        for (const row of checkChanges.slice(0, 5)) {
          body.push(`- Checks: ${row.name}: ${JSON.stringify(oldRows.get(row.key)!.checks)} → ${JSON.stringify(row.checks)}`);
        }
      }
      if (showMarks) {
        const top = listing.rows.slice(0, 3).filter((row) => row.fit?.length);
        for (const row of top) {
          body.push(`- Top row ${row.name}: ${row.holds ?? ""} — ${row.source ?? ""} — ${marks(row)}`);
        }
      }
      body.push("");
    }
    lines.push(`## ${name}`, "", `Totals: added ${added}, removed ${removed}, quantity changed ${changed}.`, "", ...body);
  };
  lines.push(`# Matches before/after`, "", `Before: ${before.at}. After: ${after.at}.`, "");
  section("Requests", before.demand, after.demand, true);
  section("Supply listings", before.supply, after.supply, false);
  return lines.join("\n");
}

async function main() {
  const [mode, a, b] = process.argv.slice(2);
  if (mode === "snapshot") {
    process.stdout.write(`${JSON.stringify(await snapshot(), null, 1)}\n`);
  } else if (mode === "diff" && a && b) {
    process.stdout.write(`${diff(JSON.parse(readFileSync(a, "utf8")), JSON.parse(readFileSync(b, "utf8")))}\n`);
  } else {
    process.stderr.write("usage: matches-before-after.ts snapshot | diff before.json after.json\n");
    process.exit(2);
  }
}

void main();
