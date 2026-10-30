import "server-only";

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import {
  compareEnergy,
  parseLabelText,
  type LabelDecision,
  type LabelReviewEntry,
  type LabelReviewPage,
} from "./contract";

const run = promisify(execFile);

/** Namespaces whose label photos are queued. Override with STOCK_LABEL_REVIEW_NAMESPACES (comma separated). */
const NAMESPACES = (process.env.STOCK_LABEL_REVIEW_NAMESPACES ?? "didier,crm:didier").split(",").map((s) => s.trim()).filter(Boolean);
const CLI = process.env.STOCK_PIPELINE_CLI ?? "/root/.hermes/profiles/enricho/workspace/enrichments/apps/stock-pipeline/cli.mjs";

let pool: pg.Pool | null = null;
/** Read-only connection to the stock ledger. Every write goes through the stock CLI, never through this pool. */
function stockPool(): pg.Pool {
  pool ??= new pg.Pool({
    connectionString: process.env.STOCK_DATABASE_URL ?? "postgresql://root@/rebattery_enrichments?host=/var/run/postgresql",
    options: "-c default_transaction_read_only=on",
    max: 3,
  });
  return pool;
}

type Row = {
  id: string; item_id: string; input_record: Record<string, any>; metadata: Record<string, any> | null; created_at: Date;
  version: number; listing_data: Record<string, any>; pack_kwh_authority: string | null;
  listing_url: string | null; donor_year: string | null; other_photos: string[] | null;
};

const QUEUE_SQL = `
WITH label AS (
  SELECT DISTINCT ON (o.item_id, o.input_record#>>'{source,url}') o.*
  FROM stock.observations o
  JOIN stock.items i ON i.id = o.item_id
  WHERE NOT o.is_primary
    AND i.supplier_namespace = ANY($1::text[])
    AND NOT (i.research_context ? 'dropped')
    AND o.input_record#>>'{source,url}' ~* '\\.(jpe?g|png|webp)(\\?.*)?$'
    AND coalesce(o.input_record->>'text', '') <> ''
    AND o.input_record#>>'{values,humanLabelCheck}' IS NULL
  ORDER BY o.item_id, o.input_record#>>'{source,url}', o.created_at DESC
)
SELECT l.id, l.item_id, l.input_record, l.metadata, l.created_at, i.version, i.listing_data,
  (SELECT a.authority FROM stock.effective_authority a WHERE a.item_id = i.id AND a.field = 'listingData.packKwh') AS pack_kwh_authority,
  (SELECT coalesce(p.input_record#>>'{input,observation,source_url}', p.input_record#>>'{input,attributes,sourceUrl}')
     FROM stock.observations p WHERE p.item_id = i.id AND p.is_primary ORDER BY p.created_at LIMIT 1) AS listing_url,
  (SELECT coalesce(p.input_record#>>'{input,attributes,supplierYear}', p.input_record#>>'{input,observation,values,details,year}')
     FROM stock.observations p WHERE p.item_id = i.id AND p.is_primary ORDER BY p.created_at LIMIT 1) AS donor_year,
  (SELECT array_agg(DISTINCT u) FROM stock.observations g, jsonb_array_elements_text(g.input_record#>'{values,imageUrls}') u
     WHERE g.item_id = i.id AND jsonb_typeof(g.input_record#>'{values,imageUrls}') = 'array') AS other_photos
FROM label l JOIN stock.items i ON i.id = l.item_id
ORDER BY i.listing_data->>'manufacturer', i.listing_data->>'model', l.item_id, l.created_at`;

const DECISIONS_SQL = `
SELECT DISTINCT ON (o.input_record#>>'{values,observationId}')
  o.input_record#>>'{values,observationId}' AS observation_id,
  o.input_record#>>'{values,humanLabelCheck}' AS decision,
  coalesce(o.input_record#>>'{values,note}', '') AS note,
  coalesce(o.input_record#>>'{values,decidedBy}', o.metadata->>'actor', '') AS by,
  o.created_at AS at
FROM stock.observations o
WHERE o.input_record#>>'{values,humanLabelCheck}' IS NOT NULL
ORDER BY o.input_record#>>'{values,observationId}', o.created_at DESC`;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export async function readLabelQueue(): Promise<LabelReviewPage> {
  const [rows, decisions] = await Promise.all([
    stockPool().query<Row>(QUEUE_SQL, [NAMESPACES]),
    stockPool().query<{ observation_id: string; decision: LabelDecision; note: string; by: string; at: Date }>(DECISIONS_SQL),
  ]);
  const decided = new Map(decisions.rows.map((d) => [d.observation_id, d]));
  const entries: LabelReviewEntry[] = [];
  for (const row of rows.rows) {
    const text = String(row.input_record.text ?? "");
    const parsed = parseLabelText(text);
    // Photos with no readable energy, voltage or capacity are descriptions, not labels.
    if (parsed.kwh === null && parsed.voltage === null && parsed.ah === null) continue;
    const ld = row.listing_data ?? {};
    const storedKwh = num(ld.packKwh);
    const photoUrl = String(row.input_record.source?.url ?? "");
    const d = decided.get(row.id);
    entries.push({
      observationId: row.id,
      itemId: row.item_id,
      itemVersion: row.version,
      actor: row.metadata?.actor ?? null,
      createdAt: row.created_at.toISOString(),
      make: ld.manufacturer ?? null,
      model: ld.model ?? null,
      partNumbers: Array.isArray(ld.partNumbers) ? ld.partNumbers : [],
      donorYear: row.donor_year,
      text,
      quote: row.input_record.quote ?? null,
      photoUrl,
      photoNumber: num(row.input_record.values?.photoNumber) ?? (Number(/photo (\d+)/i.exec(text)?.[1]) || null),
      otherPhotos: (row.other_photos ?? []).filter((u) => u !== photoUrl),
      listingUrl: row.listing_url,
      stored: { packKwh: storedKwh, voltageNominal: num(ld.voltageNominal), capacityAh: num(ld.capacityAh), packKwhAuthority: row.pack_kwh_authority },
      parsed,
      match: storedKwh === null && parsed.kwh === null ? "no_energy" : compareEnergy(parsed.kwh, storedKwh),
      decision: d ? { decision: d.decision, note: d.note, by: d.by, at: new Date(d.at).toISOString() } : null,
    });
  }
  // Mismatches first, then undecided, then the rest.
  const rank = (e: LabelReviewEntry) => (e.decision ? 3 : e.match === "mismatch" ? 0 : e.match === "no_stored" ? 1 : 2);
  entries.sort((a, b) => rank(a) - rank(b));
  return {
    entries,
    total: entries.length,
    decided: entries.filter((e) => e.decision).length,
    mismatches: entries.filter((e) => e.match === "mismatch" && !e.decision).length,
  };
}

export async function readEntry(observationId: string): Promise<LabelReviewEntry | null> {
  return (await readLabelQueue()).entries.find((e) => e.observationId === observationId) ?? null;
}

/** Runs one stock CLI command with a JSON input file, and always removes the file. */
export async function stockCli(args: string[], body: unknown, actor: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "label-review-"));
  const file = join(dir, "input.json");
  try {
    await writeFile(file, JSON.stringify(body), { mode: 0o600 });
    const { stdout } = await run("node", [CLI, ...args, "--actor", actor, "--input", file], {
      cwd: join(CLI, "..", "..", ".."),
      // The web service runs without USER set, and the CLI connects to PostgreSQL over the local socket as that user.
      env: { ...process.env, USER: process.env.USER ?? "root", PGUSER: process.env.PGUSER ?? "root" },
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function currentItemVersion(itemId: string): Promise<number> {
  const { rows } = await stockPool().query<{ version: number }>("SELECT version FROM stock.items WHERE id = $1", [itemId]);
  if (!rows[0]) throw new Error("Item not found.");
  return rows[0].version;
}
