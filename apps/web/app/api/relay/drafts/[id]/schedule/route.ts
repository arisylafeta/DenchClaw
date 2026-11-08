import { guardRelay, readBody, relayError } from "@/lib/relay-route";
import { cancelScheduledSend, scheduleSend } from "@/lib/relay";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

/**
 * Send later: schedules one Relay draft, only on Alex's explicit confirm (`confirm: true`), for the version he saw
 * (`updated_at`), at `send_at` (ISO). The scheduled-send cron sends it then through the normal send runner.
 */
export async function POST(req: Request, { params }: Context) {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  const body = await readBody(req);
  if (body?.confirm !== true || typeof body.updated_at !== "string" || typeof body.send_at !== "string") {
    return Response.json({ error: "confirm, updated_at and send_at required" }, { status: 400 });
  }
  try {
    const scheduled = await scheduleSend(id, guard.user, body.updated_at, new Date(body.send_at));
    return Response.json({ scheduled });
  } catch (error) {
    return relayError(error);
  }
}

/** Cancels the pending send-later; the draft stays. */
export async function DELETE(_req: Request, { params }: Context) {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  try {
    await cancelScheduledSend(id, guard.user.id);
    return Response.json({ cancelled: true });
  } catch (error) {
    return relayError(error);
  }
}
