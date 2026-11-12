import { ALLOWED_EMAILS } from "@/lib/auth";
import { listStoredMatches, markNewSupply, matchFailure, recordSellerQuote, runMatches, sellerReconfirm } from "@/lib/crm-postgres/bulk-matches";
import { badRequest, guardBulkTrades, readJson } from "@/lib/bulk-trades-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

/** The deal's stored matches: the five, new supply that may fit a standing request, and what was answered before. */
export async function GET(_req: Request, { params }: Context) {
  const guard = await guardBulkTrades();
  if ("response" in guard) { return guard.response; }
  const { id } = await params;
  try {
    // A standing request picks up supply added since it was last looked at; a no-op for everything else.
    await markNewSupply(id, { userId: guard.userId, email: guard.email }).catch(() => 0);
    return Response.json(await listStoredMatches(id));
  } catch (error) {
    return matchFailure(error);
  }
}

/**
 * Deal-level actions. `run` is Find matches. On a supply deal, `reconfirm` drafts the seller re-confirm and `quote`
 * records the seller's confirmed quote with its last day. Drafts are in Alex's voice, so they take the send allow-list.
 */
export async function POST(req: Request, { params }: Context) {
  const guard = await guardBulkTrades();
  if ("response" in guard) { return guard.response; }
  const { id } = await params;
  const body = await readJson(req) as { action?: unknown; validUntil?: unknown } | null;
  const actor = { userId: guard.userId, email: guard.email };
  try {
    if (body?.action === "run") {
      return Response.json(await runMatches(id, actor), { status: 201 });
    }
    if (body?.action === "reconfirm") {
      if (!ALLOWED_EMAILS.has(guard.email.toLowerCase())) {
        return Response.json({ error: "Only Ari or Alex can create drafts." }, { status: 403 });
      }
      return Response.json(await sellerReconfirm(id, actor), { status: 201 });
    }
    if (body?.action === "quote") {
      if (typeof body.validUntil !== "string") { return badRequest("Say until when the seller's quote holds."); }
      return Response.json({ sellerQuote: await recordSellerQuote(id, body.validUntil, actor) });
    }
    return badRequest("Unknown action.");
  } catch (error) {
    return matchFailure(error);
  }
}
