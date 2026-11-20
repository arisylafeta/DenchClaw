import { guardRelay, readBody, relayError } from "@/lib/relay-route";
import { cancelAll, sendWithLinked } from "@/lib/relay-talk";
import { UNDO_SEND_SECONDS } from "@/lib/relay-send-time";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

/**
 * "Send the reply and N more", only on Alex's explicit confirm (`confirm: true`) and only the versions he saw
 * (`updated_at`: draft id to the mail's updated_at). The reply and the ticked linked emails are held for `undo_seconds`
 * (DELETE here undoes them all), timed ones are scheduled, and after-order ones become a to-do.
 */
export async function POST(req: Request, { params }: Context) {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  const body = await readBody(req);
  const versions = body?.updated_at;
  if (body?.confirm !== true || !versions || typeof versions !== "object" || Array.isArray(versions)
    || !Object.values(versions).every((v) => typeof v === "string")) {
    return Response.json({ error: "confirm and updated_at (draft id to version) required" }, { status: 400 });
  }
  try {
    const sent = await sendWithLinked(id, guard.user, versions as Record<string, string>);
    return Response.json({ ...sent, undo_seconds: UNDO_SEND_SECONDS }, { status: 202 });
  } catch (error) {
    return relayError(error);
  }
}

/** Undo: stops every send still held or scheduled on this email (the reply and the linked emails). The drafts stay. */
export async function DELETE(_req: Request, { params }: Context) {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  try {
    return Response.json(await cancelAll(id, guard.user.id));
  } catch (error) {
    return relayError(error);
  }
}
