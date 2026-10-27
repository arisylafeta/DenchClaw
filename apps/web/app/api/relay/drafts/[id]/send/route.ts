import { guardRelay, readBody, relayError } from "@/lib/relay-route";
import { queueSend } from "@/lib/relay";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

/**
 * Sends one Relay draft, only on Alex's explicit confirm (`confirm: true`) and only the version he saw (`updated_at`).
 * Returns at once with 202; the send runs in the background and Relay shows its state from the message itself.
 */
export async function POST(req: Request, { params }: Context) {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  const body = await readBody(req);
  if (body?.confirm !== true || typeof body.updated_at !== "string") return Response.json({ error: "confirm and updated_at required" }, { status: 400 });
  try {
    await queueSend(id, guard.user, body.updated_at);
    return Response.json({ queued: true }, { status: 202 });
  } catch (error) {
    return relayError(error);
  }
}
