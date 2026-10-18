import { badRequest, guardBulkTrades, notFound, readJson } from "@/lib/bulk-trades-route";
import { setSuggestionStatus } from "@/lib/crm-postgres/marketplace-pulse";
import { SUGGESTION_STATUSES, type SuggestionStatus } from "@/lib/marketplace-pulse";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** PATCH { status } moves a suggestion to Doing, Done or Dismissed. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardBulkTrades("Marketplace Pulse");
  if ("response" in guard) return guard.response;
  const body = (await readJson(req)) as { status?: unknown } | null;
  if (!SUGGESTION_STATUSES.includes(body?.status as SuggestionStatus) || body?.status === "New") return badRequest("Status must be Doing, Done or Dismissed.");
  const { id } = await params;
  const saved = await setSuggestionStatus(id, body!.status as SuggestionStatus, guard.userId);
  return saved ? Response.json({ suggestion: saved }) : notFound("Suggestion");
}
