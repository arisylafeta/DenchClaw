import { guardRelay, readBody, relayError } from "@/lib/relay-route";
import { talk, talkState } from "@/lib/relay-talk";
import { TALK_ALL } from "@/lib/relay-talk-core";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 240;
type Context = { params: Promise<{ id: string }> };

/** Relay's chat on this email: the turns so far, the drafts (with marks, history and the leak guard's findings) and what Relay read. */
export async function GET(_req: Request, { params }: Context) {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  try {
    return Response.json(await talkState(id, guard.user.id));
  } catch (error) {
    return relayError(error);
  }
}

/** One chat turn: `text` is what Alex says, `target` the draft he is talking about or "all". Relay edits and adds drafts; it never sends. */
export async function POST(req: Request, { params }: Context) {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  const body = await readBody(req);
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  const target = body?.target === undefined ? TALK_ALL : body.target;
  if (!text || text.length > 2000) return Response.json({ error: "text required (up to 2000 characters)" }, { status: 400 });
  if (typeof target !== "string" || !target || target.length > 100) return Response.json({ error: "target must be a draft id or \"all\"" }, { status: 400 });
  try {
    return Response.json(await talk(id, guard.user, text, target));
  } catch (error) {
    return relayError(error);
  }
}
