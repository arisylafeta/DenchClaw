import { guardRelay, relayError } from "@/lib/relay-route";
import { priceDraft } from "@/lib/relay-price";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

/** Re-price: works out Relay's price for every price gap in the draft again, keeping Alex's own. Returns `{ fills }`. */
export async function POST(_req: Request, { params }: Context) {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  try {
    return Response.json({ fills: await priceDraft(id, guard.user.id) });
  } catch (error) {
    return relayError(error);
  }
}
