import { badRequest, guardBulkTrades, notFound, readJson } from "@/lib/bulk-trades-route";
import { dealOwner } from "@/lib/bulk-owner";
import { completeListingNext, setListingNext } from "@/lib/crm-postgres/bulk-listing-next";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (due: unknown) => due === null || (typeof due === "string" && DAY.test(due) && !Number.isNaN(Date.parse(due)));
const actionText = (text: unknown) => (typeof text === "string" && text.trim() ? text.trim().slice(0, 300) : null);

/** Body: { next_action: string | null, next_due?: "YYYY-MM-DD" | null }. Demand and supply listings. */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const body = (await readJson(req)) as { next_action?: unknown; next_due?: unknown } | null;
  if (!body || typeof body !== "object") return badRequest("Body must be an object.");
  const text = body.next_action;
  if (text !== null && typeof text !== "string") return badRequest("next_action must be text or null.");
  const due = body.next_due ?? null;
  if (!validDay(due)) return badRequest("next_due must be YYYY-MM-DD or null.");
  const action = actionText(text);
  const { id } = await params;
  return (await setListingNext(id, { next_action: action, next_due: action ? (due as string | null) : null }))
    ? Response.json({ next_action: action, next_due: action ? due : null })
    : notFound("Listing");
}

/**
 * Mark the current next action done and set the next one.
 * Body: { done: string, next_action: string | null, next_due?: "YYYY-MM-DD" | null, owner?: "Sean" | "Alex" | "Ari" }.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const body = (await readJson(req)) as { done?: unknown; next_action?: unknown; next_due?: unknown; owner?: unknown } | null;
  if (!body || typeof body !== "object") return badRequest("Body must be an object.");
  const done = actionText(body.done);
  if (!done) return badRequest("done must be the action that was done.");
  if (body.next_action != null && typeof body.next_action !== "string") return badRequest("next_action must be text or null.");
  const due = body.next_due ?? null;
  if (!validDay(due)) return badRequest("next_due must be YYYY-MM-DD or null.");
  if (body.owner != null && !dealOwner(body.owner)) return badRequest("owner must be Sean, Alex or Ari.");
  const action = actionText(body.next_action);
  const { id } = await params;
  const ok = await completeListingNext(id, { done, next_action: action, next_due: action ? (due as string | null) : null, owner: dealOwner(body.owner) ?? undefined }, guard.userId);
  return ok ? Response.json({ next_action: action, next_due: action ? due : null }) : notFound("Listing");
}
