import { guardRelay, readBody, relayError } from "@/lib/relay-route";
import { sendLeadCard } from "@/lib/relay-lead";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

/**
 * Send on a lead card, only on Alex's explicit confirm and only the reply he saw (`body`, checked word for word against
 * what the server puts together from `state`). Returns at once with 202: the email is held for `undo_seconds`
 * (POST ../undo stops it), then sent in the background. `mode: "edit"` saves it as a draft in Review instead.
 */
export async function POST(req: Request, { params }: Context) {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  const body = await readBody(req);
  if (body?.confirm !== true || typeof body.body !== "string") return Response.json({ error: "confirm and body required" }, { status: 400 });
  try {
    const sent = await sendLeadCard(id, guard.user, { state: body.state, body: body.body, mode: body.mode === "edit" ? "edit" : "send" });
    return Response.json(sent, { status: 202 });
  } catch (error) {
    return relayError(error);
  }
}
