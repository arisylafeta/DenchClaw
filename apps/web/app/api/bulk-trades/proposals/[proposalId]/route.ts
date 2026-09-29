import { decideProposal, undoChange } from "@/lib/crm-postgres/bulk-trade-proposals";
import { badRequest, guardBulkTrades, readJson } from "@/lib/bulk-trades-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Body: { action: "accept" | "ignore" | "undo" }. Accepting applies a waiting finding as the
 * signed-in user; undo reverses one the inbox check applied.
 */
export async function POST(req: Request, { params }: { params: Promise<{ proposalId: string }> }) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const body = (await readJson(req)) as { action?: unknown } | null;
  const action = body?.action;
  if (action !== "accept" && action !== "ignore" && action !== "undo") return badRequest("action must be accept, ignore or undo.");
  const { proposalId } = await params;
  if (!/^\d+$/.test(proposalId)) return badRequest("Unknown proposal.");

  const result = action === "undo"
    ? await undoChange(proposalId, guard.userId)
    : await decideProposal(proposalId, action, { id: guard.userId, email: guard.email });
  return result.ok ? Response.json({ lot_id: result.lot_id }) : Response.json({ error: result.error }, { status: result.status });
}
