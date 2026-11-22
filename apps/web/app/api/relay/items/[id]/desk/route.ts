import { guardRelay, readBody, relayError } from "@/lib/relay-route";
import { startDesk } from "@/lib/relay-desk";
import { isDeskMode } from "@/lib/relay-desk-core";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

/** Starts one desk turn on this email: `mode` quick (first draft on open), ahead (background) or chat (`text` is Alex's message).
 * 409 while a turn is already running; 503 when the desk can't start, so the page falls back to the one-shot chat or draft. */
export async function POST(req: Request, { params }: Context) {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  const body = await readBody(req);
  const mode = body?.mode ?? "chat";
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!isDeskMode(mode)) return Response.json({ error: "mode must be quick, ahead or chat" }, { status: 400 });
  if (text.length > 4000) return Response.json({ error: "text is too long (up to 4000 characters)" }, { status: 400 });
  if (mode === "chat" && !text) return Response.json({ error: "text required" }, { status: 400 });
  try {
    return Response.json({ run: await startDesk(id, guard.user.id, mode, text) });
  } catch (error) {
    return relayError(error);
  }
}
