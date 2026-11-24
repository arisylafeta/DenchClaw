import { guardRelay, readBody, relayError } from "@/lib/relay-route";
import { setLinked, type LinkedPatch } from "@/lib/relay-talk";
import { SEND_MODES } from "@/lib/relay-talk-core";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

/** A linked email: `included` (ticked to go), `send_mode` and `send_at` (ISO, for "at" and "unless_reply"). `item`: the page it is seen from. Nothing is sent. */
export async function PATCH(req: Request, { params }: Context) {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  const body = await readBody(req);
  const patch: LinkedPatch = {};
  if (body?.included !== undefined) {
    if (typeof body.included !== "boolean") return Response.json({ error: "included must be true or false" }, { status: 400 });
    patch.included = body.included;
  }
  if (body?.send_mode !== undefined) {
    const mode = SEND_MODES.find((m) => m === body.send_mode);
    if (!mode) return Response.json({ error: `send_mode must be one of ${SEND_MODES.join(", ")}` }, { status: 400 });
    patch.sendMode = mode;
  }
  if (body?.send_at !== undefined) {
    if (body.send_at !== null && typeof body.send_at !== "string") return Response.json({ error: "send_at must be an ISO time or null" }, { status: 400 });
    patch.sendAt = body.send_at;
  }
  if (!Object.keys(patch).length) return Response.json({ error: "included, send_mode or send_at required" }, { status: 400 });
  try {
    return Response.json({ drafts: await setLinked(id, guard.user.id, patch, typeof body?.item === "string" ? body.item : undefined) });
  } catch (error) {
    return relayError(error);
  }
}
