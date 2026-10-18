import { SUPPLY_CLOSED_REASONS, type SupplyClosedReason } from "@/lib/bulk-supply";
import { closeSupply, hideSupplyFit, reopenSupply } from "@/lib/crm-postgres/bulk-supply";
import { badRequest, guardBulkTrades, notFound, readJson } from "@/lib/bulk-trades-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Body: { action: "close", reason }, { action: "reopen" } or { action: "hide_fit", demand_id }. */
export async function PATCH(req: Request, { params }: { params: Promise<{ supplyId: string }> }) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const body = (await readJson(req)) as Record<string, unknown> | null;
  const { supplyId } = await params;
  let supply;
  if (body?.action === "close") {
    if (!(SUPPLY_CLOSED_REASONS as readonly unknown[]).includes(body.reason)) {
      return badRequest(`reason must be one of: ${SUPPLY_CLOSED_REASONS.join(", ")}.`);
    }
    supply = await closeSupply(supplyId, body.reason as SupplyClosedReason);
  } else if (body?.action === "reopen") {
    supply = await reopenSupply(supplyId);
  } else if (body?.action === "hide_fit") {
    if (typeof body.demand_id !== "string" || !body.demand_id) return badRequest("demand_id is required.");
    supply = await hideSupplyFit(supplyId, body.demand_id);
  } else {
    return badRequest("action must be close, reopen or hide_fit.");
  }
  return supply ? Response.json({ supply }) : notFound("Supply");
}
