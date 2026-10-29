import { z } from "zod";
import { randomUUID } from "node:crypto";
import { aggregateStock, interpretFilters, lotKeyFor, searchRows, suggestModels, supplierToken, withPackIdentity } from "@/lib/commercial-stock";
import { commercialStockAuthorised, secret, unauthorised } from "@/lib/commercial-stock-access";
import { liveStock } from "@/lib/crm-postgres/commercial-stock";

export const runtime = "nodejs";

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
  /** Conversation id: supplier tokens are stable within it and unlinkable across conversations. */
  scope: z.string().trim().min(8).max(80).optional(),
});

/** Supplier-free stock groups for Jules' commercial-buyer path. */
export async function POST(request: Request): Promise<Response> {
  if (!commercialStockAuthorised(request)) return unauthorised();
  const parsed = filters.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid filters" }, { status: 400 });
  const all = withPackIdentity(await liveStock());
  const { rows, matchedOn } = searchRows(all, parsed.data);
  // Supplier tokens and lot keys must be recomputable later (offers resolve lot keys), so no secret means no answer.
  const key = secret();
  if (!key) return Response.json({ error: "Not configured" }, { status: 503 });
  const scope = parsed.data.scope ?? randomUUID();
  const groups = aggregateStock(rows, (supplierId) => supplierToken(supplierId, scope, key),
    (supplierId, groupKey, part) => lotKeyFor(supplierId, groupKey, part, scope, key));
  return Response.json({
    groups: groups.slice(0, parsed.data.limit ?? 20),
    totalGroups: groups.length,
    totalUnits: groups.reduce((sum, group) => sum + group.units, 0),
    interpreted: { ...interpretFilters(parsed.data), ...(matchedOn === "fits" ? { matchedOn: "vehicles the pack fits" } : {}) },
    ...(groups.length ? {} : { suggestions: suggestModels(all, parsed.data) }),
  });
}
