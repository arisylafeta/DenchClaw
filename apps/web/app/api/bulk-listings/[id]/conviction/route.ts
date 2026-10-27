import { badRequest, guardBulkTrades, notFound, readJson } from "@/lib/bulk-trades-route";
import { CONVICTIONS, type Conviction } from "@/lib/bulk-conviction";
import { setListingConviction } from "@/lib/crm-postgres/bulk-listing-conviction";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Body: { conviction: "high" | "medium" | "low" }. Demand and supply listings. */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const body = (await readJson(req)) as { conviction?: unknown } | null;
  if (!body || typeof body !== "object") return badRequest("Body must be an object.");
  const conviction = CONVICTIONS.find((c) => c === body.conviction);
  if (!conviction) return badRequest("conviction must be high, medium or low.");
  const { id } = await params;
  return (await setListingConviction(id, conviction as Conviction)) ? Response.json({ conviction }) : notFound("Listing");
}
