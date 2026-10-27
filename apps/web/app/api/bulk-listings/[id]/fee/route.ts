import { badRequest, guardBulkTrades, notFound, readJson } from "@/lib/bulk-trades-route";
import { setListingFee } from "@/lib/crm-postgres/bulk-listing-fee";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Largest fee accepted, in EUR: well above any deal, low enough to catch a typo. */
const MAX_FEE_EUR = 100_000_000;

/** Body: { fee_eur: number (EUR, 0 or more) | null }. Null goes back to the default, a fixed share of the value. Demand and supply listings. */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const body = (await readJson(req)) as { fee_eur?: unknown } | null;
  if (!body || typeof body !== "object") return badRequest("Body must be an object.");
  const raw = body.fee_eur ?? null;
  if (raw !== null && (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > MAX_FEE_EUR)) {
    return badRequest("fee_eur must be a number of euros from 0 to 100,000,000, or null.");
  }
  const fee = raw === null ? null : Math.round(raw);
  const { id } = await params;
  return (await setListingFee(id, fee)) ? Response.json({ fee_eur: fee }) : notFound("Listing");
}
