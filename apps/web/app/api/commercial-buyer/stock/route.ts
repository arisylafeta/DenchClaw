import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  aggregateStock, bandOffsetFor, interpretFilters, lotKeyFor, MAX_SEARCH_GROUPS, searchRows, suggestModels,
  TOTAL_GROUPS_CAP, TOTAL_UNITS_CAP, withPackIdentity, type StockRow,
} from "@/lib/commercial-stock";
import { allowStockRequest, commercialStockAuthorised, scopeSignatureValid, secret, unauthorised } from "@/lib/commercial-stock-access";
import { liveStock } from "@/lib/crm-postgres/commercial-stock";

export const runtime = "nodejs";

/**
 * Until the platform signs every scope, an unsigned scope is still honoured (only staging consumes this API). Set to
 * false once the platform release that sends `scopeSig` is live.
 */
const ALLOW_UNSIGNED_SCOPE = true;

const text = z.string().trim().min(1).max(80).optional();
const filters = z.strictObject({
  make: text, model: text, chemistry: text, powertrain: text, country: text,
  format: z.enum(["pack", "module", "cell"]).optional(),
  kwhMin: z.number().min(0).max(2000).optional(),
  kwhMax: z.number().min(0).max(2000).optional(),
  maxPriceEurExVat: z.number().positive().max(1_000_000).optional(),
  seenWithinDays: z.number().int().min(1).max(365).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  groupKeys: z.array(z.string().regex(/^grp_[0-9a-f]{16}$/)).min(1).max(20).optional(),
  /** Conversation scope: lot keys are stable within it and unlinkable across scopes. Signed by the platform. */
  scope: z.string().trim().min(8).max(80).optional(),
  scopeSig: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  /** Server-side re-check by group keys only: adds the real asks so a blank offer is the seller's own ask. */
  exact: z.literal(true).optional(),
});

// The book is re-read at most once a minute, not on every request.
let cache: { at: number; rows: Promise<StockRow[]> } | null = null;
function cachedStock(now = Date.now()): Promise<StockRow[]> {
  if (!cache || now - cache.at > 60_000) {
    const rows = liveStock().then(withPackIdentity);
    cache = { at: now, rows };
    rows.catch(() => { if (cache?.rows === rows) cache = null; });
  }
  return cache.rows;
}

const fail = (error: string, status: number) => Response.json({ error }, { status });

/** Supplier-free stock groups for Jules' commercial-buyer path. */
export async function POST(request: Request): Promise<Response> {
  const key = secret();
  if (!key || !commercialStockAuthorised(request, key)) return unauthorised();
  if (!allowStockRequest()) return fail("rate_limited", 429);
  const parsed = filters.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail("Invalid filters", 400);
  const input = parsed.data;
  // A real filter is required, so the whole book cannot be read with an empty or country-only query.
  const filtered = Boolean(input.make || input.model || input.groupKeys?.length || input.kwhMin !== undefined || input.kwhMax !== undefined);
  if (!filtered) return fail("filter_required", 400);
  if (input.exact && !input.groupKeys?.length) return fail("Invalid filters", 400);
  if (input.scopeSig && !input.scope) return fail("Invalid scope", 400);
  if (input.scope && !(input.scopeSig ? scopeSignatureValid(input.scope, input.scopeSig, key) : ALLOW_UNSIGNED_SCOPE)) return fail("Invalid scope", 400);

  const all = await cachedStock();
  const { rows, matchedOn } = searchRows(all, input);
  const scope = input.scope ?? randomUUID();
  const recheck = Boolean(input.groupKeys?.length);
  const groups = aggregateStock(rows, {
    lotKey: (supplierId, groupKey, part) => lotKeyFor(supplierId, groupKey, part, scope, key),
    bandOffset: (supplierId, groupKey, part) => bandOffsetFor(supplierId, groupKey, part, key),
    exact: input.exact,
  }, recheck ? 200 : undefined);
  // A re-check by group keys returns every group and lot asked for; a search is capped.
  const shown = recheck ? groups : groups.slice(0, Math.min(input.limit ?? MAX_SEARCH_GROUPS, MAX_SEARCH_GROUPS));
  const units = groups.reduce((sum, group) => sum + group.units, 0);
  return Response.json({
    groups: shown,
    totalGroups: Math.min(groups.length, TOTAL_GROUPS_CAP),
    totalUnits: Math.min(units, TOTAL_UNITS_CAP),
    totalsCapped: groups.length > TOTAL_GROUPS_CAP || units > TOTAL_UNITS_CAP,
    interpreted: { ...interpretFilters(input), ...(matchedOn === "fits" ? { matchedOn: "vehicles the pack fits" } : {}) },
    ...(groups.length ? {} : { suggestions: suggestModels(all, input) }),
  });
}
