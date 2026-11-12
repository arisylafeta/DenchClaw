import { getListing } from "@/lib/crm-postgres/bulk-listings";
import { removeStuckListing, STUCK_REASONS, type StuckReason } from "@/lib/crm-postgres/bulk-notes";
import { badRequest, guardBulkTrades, notFound, readJson } from "@/lib/bulk-trades-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

/** Today's "Stuck in New": remove the deal with a reason (closed, never deleted; it can be reopened). */
export async function POST(req: Request, { params }: Context) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  const body = await readJson(req) as { reason?: unknown; why?: unknown } | null;
  if (!STUCK_REASONS.includes(body?.reason as StuckReason)) return badRequest("Pick why it is removed.");
  if (typeof body?.why !== "string" || !body.why.trim()) return badRequest("Say why in a few words.");
  if (!await getListing(id)) return notFound("Listing");
  const done = await removeStuckListing(id, body.reason as StuckReason, body.why, { userId: guard.userId, email: guard.email });
  return Response.json({ ok: true, already: !done });
}
