import { CLOSED_REASONS, parseDemandInput, type ClosedReason } from "@/lib/bulk-demand";
import { closeDemand, confirmDemand, updateDemand } from "@/lib/crm-postgres/bulk-demand";
import { badRequest, guardBulkTrades, notFound, readJson } from "@/lib/bulk-trades-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Body: { action: "confirm" } ("Still wanted"), { action: "close", reason }, or the fields to edit.
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
  } else {
    const parsed = parseDemandInput(body, false);
    if ("error" in parsed) return badRequest(parsed.error);
    demand = await updateDemand(demandId, parsed.value);
  }
  return demand ? Response.json({ demand }) : notFound("Demand");
}
