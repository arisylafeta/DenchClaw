/**
 * Read-only before/after check for the Matches tabs. `snapshot` runs the request matcher for every open or
 * qualifying request, and the supply matcher's live-ask rows for every open or qualifying supply listing, on the
 * local CRM database, and prints one JSON snapshot. `diff` compares two snapshots as Markdown. Every connection is
 * set read-only, so nothing here can write. Marketplace listings come from the platform database and are left out
 * unless its environment is set.
 *
 *   node --conditions=react-server --import tsx scripts/matches-before-after.ts snapshot > before.json
 *   node --import tsx scripts/matches-before-after.ts diff before.json after.json > report.md
 *   node --import tsx scripts/matches-before-after.ts groups before.json after.json > groups.md
 *
 * `groups` (Matches v4 slice 2) reads the request rows: rows before, rows after, the biggest groups with their
 * "Same pack in" lists, every "Pack type not confirmed" group, and groups that look wrongly merged.
 */
import { readFileSync } from "node:fs";
import type { MatchRow } from "../lib/matches-types";

type GroupSnap = {
  pack: string; count: number; unsure: boolean; lots: boolean; sameLabel: string | null; vehicles: { name: string; n: number }[];
  meta: string; why: string | null; priceVaries?: boolean; units: { key: string; vehicle: string; ref: string | null; soh: string; price: string | null }[];
};
type Row = Pick<MatchRow, "key" | "name" | "detail" | "reason" | "checks" | "tags"> & {
  holds?: string | null; source?: string | null; fit?: { label: string; state: string }[]; stockTitle?: string | null;
  group?: GroupSnap | null;
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
        ...(row.group ? {
          group: {
            pack: row.group.pack, count: row.group.count, unsure: row.group.unsure, lots: row.group.lots, sameLabel: row.group.sameLabel,
            vehicles: row.group.vehicles, meta: row.group.meta, priceVaries: row.group.priceVaries,
            why: row.group.why ? `${row.group.why.title}: ${row.group.why.text}${row.group.why.source ? ` (${row.group.why.source})` : ""}` : null,
            units: row.group.units.map((unit) => ({ key: unit.key, vehicle: unit.vehicle, ref: unit.ref, soh: `${unit.soh.label}${unit.soh.source ? ` (${unit.soh.source})` : ""}`, price: unit.price })),
          },
        } : {}),
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

/** Units a row stands for: a group's stock lines, or the row itself. */
const unitKeys = (row: Row) => (row.group ? row.group.units.map((unit) => unit.key) : [row.key]);
const vehicles = (group: GroupSnap) => group.vehicles.map((vehicle) => `${vehicle.name} ${vehicle.n}`).join(", ");

/**
 * What might be a wrong merge, for Alex's eye: a group across makes (only right when the platform is shared), listed kWh
 * that differ by more than 10% inside one group, or an unconfirmed group holding more than one vehicle (never expected).
 */
function suspicious(group: GroupSnap): string[] {
  const flags: string[] = [];
  const makes = new Set(group.vehicles.map((vehicle) => vehicle.name.split(" ")[0].toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")));
  if (group.unsure && group.vehicles.length > 1) flags.push(`unconfirmed group holds ${group.vehicles.length} vehicles`);
  if (!group.lots && makes.size > 1) {
    const how = group.why?.match(/(battery graph[^)]*|every unit states part number [^,.]*)/i)?.[0] ?? "";
    flags.push(`${makes.size} makes (${[...makes].join(", ")})${how ? `; ${how}` : ""}`);
  }
  const range = group.why?.match(/Listed capacity: (\d+(?:\.\d+)?)–(\d+(?:\.\d+)?) kWh/);
  if (range && Number(range[2]) > Number(range[1]) * 1.1) flags.push(`listed ${range[1]}–${range[2]} kWh under one part number`);
  if (group.priceVaries) flags.push("prices vary a lot (top over 2.5× the lowest)");
  return flags;
}

function groupsReport(before: Snapshot, after: Snapshot, focus: string[]): string {
  const lines: string[] = [`# Matches v4 slice 2: grouped stock, before/after`, "", `Before: ${before.at}. After: ${after.at}. Requests only; the supply tab is unchanged.`, ""];
  const byId = new Map(before.demand.map((listing) => [listing.id, listing]));
  const totals = { before: 0, after: 0, groups: 0, grouped: 0, unsure: 0, flagged: 0, lost: 0 };
  const body: string[] = [];
  const ordered = [...after.demand].sort((a, b) => Number(focus.includes(b.id)) - Number(focus.includes(a.id)) || b.rows.length - a.rows.length);
  for (const listing of ordered) {
    const old = byId.get(listing.id);
    const groups = listing.rows.filter((row) => row.group);
    const unsure = groups.filter((row) => row.group!.unsure);
    const beforeKeys = new Set((old?.rows ?? []).map((row) => row.key));
    const afterKeys = new Set(listing.rows.flatMap(unitKeys));
    const lost = [...beforeKeys].filter((key) => !afterKeys.has(key));
    totals.before += old?.rows.length ?? 0;
    totals.after += listing.rows.length;
    totals.groups += groups.length;
    totals.grouped += groups.reduce((sum, row) => sum + row.group!.units.length, 0);
    totals.unsure += unsure.length;
    totals.lost += lost.length;
    body.push(`### ${listing.title}${focus.includes(listing.id) ? " (named in the brief)" : ""}`, "",
      `\`${listing.id}\` · rows before ${old?.rows.length ?? 0}, rows after ${listing.rows.length} · ${groups.length} groups holding ${groups.reduce((sum, row) => sum + row.group!.units.length, 0)} stock lines · ${unsure.length} "Pack type not confirmed"${lost.length ? ` · **${lost.length} units missing after**` : ""}`, "");
    for (const row of [...groups].sort((a, b) => b.group!.count - a.group!.count).slice(0, 5)) {
      const group = row.group!;
      const flags = suspicious(group);
      if (flags.length) totals.flagged += 1;
      body.push(`- ${row.name} · ${group.pack} × ${group.count}${group.lots ? " lots" : ""}${group.unsure ? " · Pack type not confirmed" : ""}${group.vehicles.length ? ` · ${group.sameLabel}: ${vehicles(group)}` : ""}${flags.length ? ` · **check: ${flags.join("; ")}**` : ""}`);
      body.push(`  - ${group.meta}`);
      body.push(`  - Units: ${group.units.map((unit) => `${unit.vehicle}${unit.ref ? ` [${unit.ref}]` : ""} ${unit.price ?? "no price"}, ${unit.soh}`).join("; ")}`);
    }
    for (const row of unsure.filter((row) => !groups.slice(0, 5).includes(row))) {
      body.push(`- ${row.name} · ${row.group!.pack} × ${row.group!.count} · Pack type not confirmed · Listed as: ${vehicles(row.group!)}`);
    }
    for (const row of [...groups].sort((a, b) => b.group!.count - a.group!.count).slice(5).filter((row) => !row.group!.unsure)) {
      const flags = suspicious(row.group!);
      if (flags.length) {
        totals.flagged += 1;
        body.push(`- ${row.name} · ${row.group!.pack} × ${row.group!.count} · **check: ${flags.join("; ")}**`);
      }
    }
    if (lost.length) body.push(`- Missing after grouping: ${lost.join(", ")}`);
    body.push("");
  }
  lines.push(`Totals: ${totals.before} rows before, ${totals.after} rows after across ${after.demand.length} requests; ${totals.groups} groups hold ${totals.grouped} stock lines; ${totals.unsure} "Pack type not confirmed" groups; ${totals.flagged} groups flagged to check; ${totals.lost} units missing after grouping.`, "", ...body);
  return lines.join("\n");
}

async function main() {
  const [mode, a, b] = process.argv.slice(2);
  if (mode === "snapshot") {
    process.stdout.write(`${JSON.stringify(await snapshot(), null, 1)}\n`);
  } else if (mode === "groups" && a && b) {
    process.stdout.write(`${groupsReport(JSON.parse(readFileSync(a, "utf8")), JSON.parse(readFileSync(b, "utf8")), process.argv.slice(5))}\n`);
  } else if (mode === "diff" && a && b) {
    process.stdout.write(`${diff(JSON.parse(readFileSync(a, "utf8")), JSON.parse(readFileSync(b, "utf8")))}\n`);
  } else {
    process.stderr.write("usage: matches-before-after.ts snapshot | diff before.json after.json | groups before.json after.json [request ids to lead with]\n");
    process.exit(2);
  }
}

void main();
