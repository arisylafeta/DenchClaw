import { badRequest, guardBulkTrades, notFound, readJson } from "@/lib/bulk-trades-route";
import { likelihoodOf } from "@/lib/bulk-likelihood";
import { setListingLikelihood } from "@/lib/crm-postgres/bulk-listing-likelihood";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Body: { likelihood: number 0-100 | null }. Demand and supply listings. */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const body = (await readJson(req)) as { likelihood?: unknown } | null;
  if (!body || typeof body !== "object") return badRequest("Body must be an object.");
  const likelihood = body.likelihood ?? null;
  if (likelihood !== null && likelihoodOf(likelihood) === null) return badRequest("likelihood must be a number from 0 to 100, or null.");
  const { id } = await params;
  return (await setListingLikelihood(id, likelihoodOf(likelihood))) ? Response.json({ likelihood: likelihoodOf(likelihood) }) : notFound("Listing");
}
