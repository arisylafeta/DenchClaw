import { decideProposal } from "@/lib/crm-postgres/bulk-trade-proposals";
import { badRequest, guardBulkTrades, readJson } from "@/lib/bulk-trades-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Body: { action: "accept" | "ignore" }. Accepting applies the change as the signed-in user. */
export async function POST(req: Request, { params }: { params: Promise<{ proposalId: string }> }) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const body = (await readJson(req)) as { action?: unknown } | null;
  if (body?.action !== "accept" && body?.action !== "ignore") return badRequest("action must be accept or ignore.");
  const { proposalId } = await params;
  if (!/^\d+$/.test(proposalId)) return badRequest("Unknown proposal.");

  const result = await decideProposal(proposalId, body.action, { id: guard.userId, email: guard.email });
  return result.ok ? Response.json({ lot_id: result.lot_id }) : Response.json({ error: result.error }, { status: result.status });
}
