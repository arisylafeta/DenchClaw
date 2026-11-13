import { sellerKey } from "../demand-match";
import { lineCap, lineFor, needText, type DemandLine, type LineCandidate } from "../demand-lines";
import type { LineCoverage, MatchRow, SupplierMatch, SupplierStock } from "../matches-types";

/**
 * Group matches, the pure part: the request's ranked rows turned round so each supplier is one row holding every
 * matching pack type, each type counted against the buyer's pack types. Nothing is matched again: the rows are the
 * ones Per battery shows, so the two views always agree. Only stated quantities count, and a pack only close to a type
 * (capacity not stated, pack not confirmed) is a maybe: shown, but never what makes a type covered or a supplier rank.
 */

/** A row's stock lines, keyed as the rows key them (`stock:<id>`, `listing:<id>`). */
export type RowCandidates = Map<string, LineCandidate & { units: number | null }>;

const PRICE = /^[A-Z]{3} [\d,.]+/;
const KWH = /(\d+(?:\.\d+)?)\s*kwh/i;
/** A capacity the row's own pack name states ("Cupra Born 63 kWh pack"), for units that do not state one themselves. */
const kwhIn = (text: string | null | undefined) => { const m = text?.match(KWH); return m ? Number(m[1]) : null; };

/** Which buyer pack type a row counts towards: the type most of its units are, and "close" if any unit only nearly is. */
function rowLine(row: MatchRow, candidates: RowCandidates, lines: DemandLine[]): Pick<SupplierStock, "line" | "lineState" | "why"> {
  if (!lines.length) return { line: null, lineState: null, why: null };
  const keys = row.group ? row.group.units.map((unit) => unit.key) : [row.key];
  const named = kwhIn(row.group?.pack ?? row.holds);
  const fits = keys.map((key) => candidates.get(key)).filter((c): c is NonNullable<typeof c> => !!c)
    .map((c) => lineFor(c.kwh == null && named != null ? { ...c, kwh: named, kwhEstimated: false } : c, lines));
  const tally = new Map<string, number>();
  for (const fit of fits) if (fit) tally.set(fit.line.id, (tally.get(fit.line.id) ?? 0) + 1);
  const top = [...tally].sort((a, b) => b[1] - a[1] || lines.findIndex((l) => l.id === a[0]) - lines.findIndex((l) => l.id === b[0]))[0];
  if (!top) return { line: null, lineState: null, why: null };
  const line = lines.find((l) => l.id === top[0])!;
  const mine = fits.filter((fit) => fit?.line.id === line.id);
  const why = row.group?.unsure ? "pack not confirmed" : mine.find((fit) => fit?.state === "close")?.why ?? null;
  return { line: { id: line.id, label: line.label }, lineState: why ? "close" : "fits", why };
}

/** One row as a supplier's pack type. */
function stockOf(row: MatchRow, candidates: RowCandidates, lines: DemandLine[]): SupplierStock {
  const group = row.group;
  const single = group ? null : candidates.get(row.key);
  const count = group ? group.count : single?.units ?? 0;
  const stated = group ? true : single?.units != null;
  const metaPrice = group && PRICE.test(group.meta) ? group.meta.split(" · ")[0] : null;
  return {
    rowKey: row.key,
    pack: group ? group.pack : row.holds ?? row.reason,
    count,
    stated,
    ...rowLine(row, candidates, lines),
    vehicles: group && group.vehicles.length > 1 ? group.vehicles.map((v) => `${v.name} ${v.n}`).join(", ") : null,
    meta: group ? group.meta : [row.price, row.source].filter(Boolean).join(" · ") || null,
    price: metaPrice ?? row.price,
    priceVaries: !!group?.priceVaries,
    stockIds: group?.stockIds.length ? group.stockIds : row.stockId ? [row.stockId] : [],
    units: group ? group.units.length : 1,
  };
}

const supplierKey = (row: MatchRow) => (row.companyId ? `company:${row.companyId}` : row.personId ? `person:${row.personId}` : `name:${sellerKey(row.name)}`);

/**
 * The buyer's pack types, found against need, and the suppliers. Suppliers are ordered by how much of the need their
 * confirmed stock covers (each type counted up to its most), then how many types, then packs on the types, then name.
 */
export function supplierView(rows: MatchRow[], candidates: RowCandidates, lines: DemandLine[]): { lines: LineCoverage[] | null; suppliers: SupplierMatch[] } {
  const bySupplier = new Map<string, MatchRow[]>();
  for (const row of rows) {
    const key = supplierKey(row);
    bySupplier.set(key, [...(bySupplier.get(key) ?? []), row]);
  }
  const order = new Map(lines.map((line, i) => [line.id, i]));
  const suppliers: SupplierMatch[] = [...bySupplier].map(([key, mine]) => {
    const stock = mine.map((row) => stockOf(row, candidates, lines))
      .sort((a, b) => (a.line ? order.get(a.line.id)! : 99) - (b.line ? order.get(b.line.id)! : 99) || b.count - a.count);
    const cover = lines.map((line) => {
      const on = stock.filter((s) => s.line?.id === line.id);
      const count = on.reduce((n, s) => n + s.count, 0);
      return { id: line.id, label: line.label, count, state: (!on.length ? "none" : on.some((s) => s.lineState === "fits") ? "fits" : "close") as "fits" | "close" | "none" };
    });
    const onLines = stock.filter((s) => s.line).reduce((n, s) => n + s.count, 0);
    const other = stock.filter((s) => !s.line).reduce((n, s) => n + s.count, 0);
    // Confirmed stock ranks: a pack only close to a type (capacity not stated, pack not confirmed) does not count here.
    const confirmed = (line: DemandLine) => stock.filter((s) => s.line?.id === line.id && s.lineState === "fits").reduce((n, s) => n + s.count, 0);
    const needCovered = lines.length ? lines.reduce((n, line) => n + Math.min(confirmed(line), lineCap(line)), 0) : other;
    const first = mine[0];
    return {
      key,
      name: first.name,
      countries: [...new Set(mine.map((row) => row.country).filter((c): c is string => !!c))],
      tags: [...new Set(mine.flatMap((row) => row.tags))],
      sourceKinds: [...new Set(mine.map((row) => row.sourceKind).filter((s): s is string => !!s))],
      offer: mine.find((row) => row.offer)?.offer ?? null,
      companyId: first.companyId,
      personId: first.personId,
      contact: mine.find((row) => row.contact)?.contact ?? null,
      stock,
      cover,
      onLines,
      other,
      linesCovered: cover.filter((c) => c.count > 0 || c.state !== "none").length,
      needCovered,
      otherOnly: lines.length > 0 && !stock.some((s) => s.line),
      rowKeys: mine.map((row) => row.key),
    };
  }).sort((a, b) => b.needCovered - a.needCovered || b.linesCovered - a.linesCovered || b.onLines - a.onLines || a.name.localeCompare(b.name));

  if (!lines.length) return { lines: null, suppliers };
  const coverage: LineCoverage[] = lines.map((line) => {
    const held = suppliers.flatMap((s) => s.stock.filter((st) => st.line?.id === line.id));
    const found = held.reduce((n, s) => n + s.count, 0);
    const close = held.filter((s) => s.lineState === "close").reduce((n, s) => n + s.count, 0);
    return {
      id: line.id, label: line.label, need: needText(line), qtyMin: line.qty_min, qtyMax: line.qty_max, found, close,
      suppliers: suppliers.filter((s) => s.stock.some((st) => st.line?.id === line.id)).length,
      // Fits only on confirmed stock: maybes alone never say a type is covered.
      state: found - close >= line.qty_min ? "fits" : found > 0 ? "close" : "misses",
    };
  });
  return { lines: coverage, suppliers };
}
