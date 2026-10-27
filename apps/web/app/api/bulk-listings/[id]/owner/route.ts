import { badRequest, guardBulkTrades, notFound, readJson } from "@/lib/bulk-trades-route";
import { dealOwner } from "@/lib/bulk-owner";
import { setListingOwner } from "@/lib/crm-postgres/bulk-listing-owner";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Body: { owner: "Sean" | "Alex" | "Ari" | null }. Demand and supply listings. */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const body = (await readJson(req)) as { owner?: unknown } | null;
  if (!body || typeof body !== "object") return badRequest("Body must be an object.");
  const owner = body.owner ?? null;
  if (owner !== null && !dealOwner(owner)) return badRequest("owner must be Sean, Alex, Ari or null.");
  const { id } = await params;
  return (await setListingOwner(id, dealOwner(owner)))
    ? Response.json({ owner: dealOwner(owner) })
    : notFound("Listing");
}
