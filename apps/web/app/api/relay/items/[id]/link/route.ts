import { guardRelay, relayError } from "@/lib/relay-route";
import { linkDeal } from "@/lib/relay";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

/** "Link to deal": ties the email's thread to a deal by hand ({ listing_id }), or removes that link ({ listing_id: null }). Nothing is sent. */
export async function POST(req: Request, { params }: Context) {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  const listingId = (await req.json().catch(() => null) as { listing_id?: unknown } | null)?.listing_id;
  if (listingId !== null && (typeof listingId !== "string" || !listingId.trim())) return Response.json({ error: "listing_id must be a deal id or null" }, { status: 400 });
  try { return Response.json({ item: await linkDeal(id, guard.user.id, listingId, guard.user.email) }); } catch (error) { return relayError(error); }
}
