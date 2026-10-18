import { deleteDemandActivity } from "@/lib/crm-postgres/bulk-demand-activity";
import { badRequest, guardBulkTrades, notFound } from "@/lib/bulk-trades-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function DELETE(_req: Request, { params }: { params: Promise<{ demandId: string; activityId: string }> }) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const { demandId, activityId } = await params;
  if (!/^[1-9]\d*$/.test(activityId) || activityId.length > 19 || BigInt(activityId) > 9223372036854775807n) return badRequest("Invalid activity ID.");
  return await deleteDemandActivity(demandId, activityId) ? Response.json({ ok: true }) : notFound("Activity");
}
