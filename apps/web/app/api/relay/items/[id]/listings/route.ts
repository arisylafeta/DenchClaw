import { guardRelay, readBody, relayError } from "@/lib/relay-route";
import { approveListings, declineListings } from "@/lib/relay-listings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

/** The "Prepare listings and link" card: `approve` creates the drafts and the link (Alex's go-ahead for the marketplace
 * writes); `decline` puts the sell page in the reply instead. Nothing is sent or published. */
export async function POST(req: Request, { params }: Context) {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  const body = await readBody(req);
  try {
    if (body?.action === "approve") return Response.json({ listings: await approveListings(id, guard.user.id, guard.user.email) });
    if (body?.action === "decline") return Response.json({ listings: await declineListings(id, guard.user.id) });
    return Response.json({ error: "action must be approve or decline" }, { status: 400 });
  } catch (error) {
    return relayError(error);
  }
}
