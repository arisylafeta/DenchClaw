import { guardRelay, relayError } from "@/lib/relay-route";
import { draftAsk } from "@/lib/relay";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

/** "Draft the ask": drafts the playbook's ask for what the linked deal is still missing. Nothing is sent. */
export async function POST(_req: Request, { params }: Context) {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  try { return Response.json({ item: await draftAsk(id, guard.user.id) }); } catch (error) { return relayError(error); }
}
