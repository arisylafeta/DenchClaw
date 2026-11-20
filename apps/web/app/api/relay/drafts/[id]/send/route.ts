import { guardRelay, readBody, relayError } from "@/lib/relay-route";
import { queueSend, readSeenFills } from "@/lib/relay";
import { UNDO_SEND_SECONDS } from "@/lib/relay-send-time";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

/**
 * Sends one Relay draft, only on Alex's explicit confirm (`confirm: true`) and only the version he saw (`updated_at`).
 * Returns at once with 202. The email is held for `undo_seconds` (DELETE ../schedule undoes it), then sent in the
 * background; Relay shows its state from the message itself. Relay's prices go into the email before it is held, and
 * `updated_at` in the answer is the version that goes. Optional `fills` ([{ key, value }]): the prices the page showed;
 * the send is refused if they changed since.
 */
export async function POST(req: Request, { params }: Context) {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  const body = await readBody(req);
  if (body?.confirm !== true || typeof body.updated_at !== "string") return Response.json({ error: "confirm and updated_at required" }, { status: 400 });
  const fills = readSeenFills(body.fills);
  if ("error" in fills) return Response.json({ error: fills.error }, { status: 400 });
  try {
    const held = await queueSend(id, guard.user, body.updated_at, fills.seen);
    return Response.json({ queued: true, send_at: held.at, updated_at: held.updated_at, undo_seconds: UNDO_SEND_SECONDS }, { status: 202 });
  } catch (error) {
    return relayError(error);
  }
}
