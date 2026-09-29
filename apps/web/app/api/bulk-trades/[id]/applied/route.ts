import { undoRun } from "@/lib/crm-postgres/bulk-trade-proposals";
import { badRequest, guardBulkTrades, readJson } from "@/lib/bulk-trades-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Body: { undo_run: "<run id>" }. Undoes everything that inbox-check run applied to this trade. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const body = (await readJson(req)) as { undo_run?: unknown } | null;
  const runId = typeof body?.undo_run === "string" ? body.undo_run : "";
  if (!/^\d+$/.test(runId)) return badRequest("undo_run must be a run id.");
  const { id } = await params;
  return Response.json(await undoRun(id, runId, guard.userId));
}
