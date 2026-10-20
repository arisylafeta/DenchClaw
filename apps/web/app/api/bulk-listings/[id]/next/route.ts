import { badRequest, guardBulkTrades, notFound, readJson } from "@/lib/bulk-trades-route";
import { setListingNext } from "@/lib/crm-postgres/bulk-listing-next";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Body: { next_action: string | null, next_due?: "YYYY-MM-DD" | null }. Demand and supply listings. */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const body = (await readJson(req)) as { next_action?: unknown; next_due?: unknown } | null;
  if (!body || typeof body !== "object") return badRequest("Body must be an object.");
  const text = body.next_action;
  if (text !== null && typeof text !== "string") return badRequest("next_action must be text or null.");
  const due = body.next_due ?? null;
  if (due !== null && (typeof due !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(due) || Number.isNaN(Date.parse(due)))) return badRequest("next_due must be YYYY-MM-DD or null.");
  const action = typeof text === "string" && text.trim() ? text.trim().slice(0, 300) : null;
  const { id } = await params;
  return (await setListingNext(id, { next_action: action, next_due: action ? due : null }))
    ? Response.json({ next_action: action, next_due: action ? due : null })
    : notFound("Listing");
}
