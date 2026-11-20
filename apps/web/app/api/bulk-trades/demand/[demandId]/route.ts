import { BASES, CLOSED_REASONS, floorAboveCeiling, parseDemandInput, type Basis, type ClosedReason } from "@/lib/bulk-demand";
import { categorizeDemand, closeDemand, confirmDemand, getDemand, makeStanding, setBasis, updateDemand } from "@/lib/crm-postgres/bulk-demand";
import { loadRegistry } from "@/lib/crm-postgres/bulk-registry";
import { badRequest, guardBulkTrades, notFound, readJson } from "@/lib/bulk-trades-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Body: { action: "confirm" } ("Still wanted"), { action: "close", reason }, { action: "basis", basis } (standing
 * buy-boxes: estimated, stated, agreed), { action: "make_standing" } (a request becomes a stated buy-box), or the
 * fields to edit.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ demandId: string }> }) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const body = (await readJson(req)) as Record<string, unknown> | null;
  const { demandId } = await params;
  let demand;
  if (body?.action === "confirm") {
    demand = await confirmDemand(demandId);
  } else if (body?.action === "close") {
    if (!(CLOSED_REASONS as readonly unknown[]).includes(body.reason)) return badRequest(`reason must be one of: ${CLOSED_REASONS.join(", ")}.`);
    demand = await closeDemand(demandId, body.reason as ClosedReason);
  } else if (body?.action === "category") {
    if (!(CLOSED_REASONS as readonly unknown[]).includes(body.reason)) return badRequest(`reason must be one of: ${CLOSED_REASONS.join(", ")}.`);
    demand = await categorizeDemand(demandId, body.reason as ClosedReason);
  } else if (body?.action === "basis") {
    if (!(BASES as readonly unknown[]).includes(body.basis)) return badRequest(`basis must be one of: ${BASES.join(", ")}.`);
    demand = await setBasis(demandId, body.basis as Basis);
  } else if (body?.action === "make_standing") {
    demand = await makeStanding(demandId);
  } else {
    const parsed = parseDemandInput(body, false, await loadRegistry());
    if ("error" in parsed) return badRequest(parsed.error);
    // The floor and the ceiling can be saved separately: check the half that is not in this body against the saved one.
    if (parsed.value.spec || parsed.value.max_price !== undefined) {
      const saved = await getDemand(demandId);
      if (saved) {
        const problem = floorAboveCeiling(parsed.value.spec ?? saved.spec, {
          max_price: parsed.value.max_price !== undefined ? parsed.value.max_price : saved.max_price,
          price_currency: parsed.value.price_currency !== undefined ? parsed.value.price_currency : saved.price_currency,
          price_unit: parsed.value.price_unit !== undefined ? parsed.value.price_unit : saved.price_unit,
        });
        if (problem) return badRequest(problem);
      }
    }
    demand = await updateDemand(demandId, parsed.value);
  }
  return demand ? Response.json({ demand }) : notFound("Demand");
}
