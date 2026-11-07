import { guardRelay, relayError } from "@/lib/relay-route";
import { dismantlerReply } from "@/lib/relay";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

/** "Reply: list it": drafts the dismantler reply that points them to the marketplace or their stock list. Nothing is sent. */
export async function POST(_req: Request, { params }: Context) {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  try { return Response.json({ item: await dismantlerReply(id, guard.user.id) }); } catch (error) { return relayError(error); }
}
