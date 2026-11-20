import { guardRelay, relayError } from "@/lib/relay-route";
import { priceStock, stockReport } from "@/lib/relay-price";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

/**
 * The stock that fits what this email asks for, best first, and Relay's price for each (same order): `{ fits, prices,
 * ask, errors }`. Supplier details in `fits` are for Alex only, never for an email to the buyer. Read only.
 */
export async function GET(_req: Request, { params }: Context) {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  try {
    const report = await stockReport(id, guard.user.id);
    const prices = await priceStock(report.fits, { askedDelivered: report.ask.delivered });
    return Response.json({ fits: report.fits, prices, ask: report.ask, errors: report.errors });
  } catch (error) {
    return relayError(error);
  }
}
