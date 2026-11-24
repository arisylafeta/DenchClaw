import { guardRelay, readBody, relayError } from "@/lib/relay-route";
import { undoDraft } from "@/lib/relay-talk";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

/** Undo the last change to a draft (Relay's or an AI edit), or `{ redo: true }` to put it back. Returns the email's drafts. */
export async function POST(req: Request, { params }: Context) {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  const body = await readBody(req);
  try {
    return Response.json({ drafts: await undoDraft(id, guard.user.id, body?.redo === true, typeof body?.item === "string" ? body.item : undefined) });
  } catch (error) {
    return relayError(error);
  }
}
