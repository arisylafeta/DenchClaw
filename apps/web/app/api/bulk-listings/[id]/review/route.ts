import { badRequest, guardBulkTrades, notFound, readJson } from "@/lib/bulk-trades-route";
import { reviewListing } from "@/lib/crm-postgres/bulk-listing-review";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Body: { decision: "approve" | "reject" } for a listing an import flagged for review. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const body = (await readJson(req)) as { decision?: unknown } | null;
  const decision = body?.decision;
  if (decision !== "approve" && decision !== "reject") return badRequest("decision must be approve or reject.");
  const { id } = await params;
  const result = await reviewListing(id, decision, guard.userId);
  if (result === "missing") return notFound("Listing");
  if (result === "not_pending") return Response.json({ error: "This listing is not waiting for review." }, { status: 409 });
  return Response.json({ ok: true });
}
