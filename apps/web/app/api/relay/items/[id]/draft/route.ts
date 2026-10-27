import { guardRelay, readBody, relayError } from "@/lib/relay-route";
import { draftFromNote } from "@/lib/relay";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;
type Context = { params: Promise<{ id: string }> };

/** Drafts v1 from the note (plus follow-ons and to-dos) and moves the item to Review. Never sends. */
export async function POST(req: Request, { params }: Context) {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  const note = (await readBody(req))?.note;
  if (typeof note !== "string") return Response.json({ error: "note required" }, { status: 400 });
  try {
    return Response.json({ item: await draftFromNote(id, guard.user.id, note) });
  } catch (error) {
    return relayError(error);
  }
}
