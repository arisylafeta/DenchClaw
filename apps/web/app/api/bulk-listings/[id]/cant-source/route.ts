import { badRequest, guardBulkTrades, notFound, readJson } from "@/lib/bulk-trades-route";
import { setListingCantSource } from "@/lib/crm-postgres/bulk-listing-cant-source";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Body: { reason: string | null }. Demand listings only. Blank or null clears it. */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const body = (await readJson(req)) as { reason?: unknown } | null;
  if (!body || typeof body !== "object") return badRequest("Body must be an object.");
  const raw = body.reason ?? null;
  if (raw !== null && typeof raw !== "string") return badRequest("reason must be text or null.");
  const reason = typeof raw === "string" && raw.trim() ? raw.trim().slice(0, 300) : null;
  const { id } = await params;
  return (await setListingCantSource(id, reason)) ? Response.json({ reason }) : notFound("Demand listing");
}
