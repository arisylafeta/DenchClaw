import { guardRelay, readBody, relayError } from "@/lib/relay-route";
import { queueSend } from "@/lib/relay";
import { UNDO_SEND_SECONDS } from "@/lib/relay-send-time";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

/**
 * Sends one Relay draft, only on Alex's explicit confirm (`confirm: true`) and only the version he saw (`updated_at`).
 * Returns at once with 202. The email is held for `undo_seconds` (DELETE ../schedule undoes it), then sent in the
 * background; Relay shows its state from the message itself.
 */
export async function POST(req: Request, { params }: Context) {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  const body = await readBody(req);
  if (body?.confirm !== true || typeof body.updated_at !== "string") return Response.json({ error: "confirm and updated_at required" }, { status: 400 });
  try {
    const held = await queueSend(id, guard.user, body.updated_at);
    return Response.json({ queued: true, send_at: held.at, undo_seconds: UNDO_SEND_SECONDS }, { status: 202 });
  } catch (error) {
    return relayError(error);
  }
}
