import { guardRelay, relayError } from "@/lib/relay-route";
import { undoLeadSend } from "@/lib/relay-lead";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

/** Undo on a lead card inside the hold: the email does not go and the card is back as Alex left it. */
export async function POST(_req: Request, { params }: Context) {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  try {
    await undoLeadSend(id, guard.user.id);
    return Response.json({ ok: true });
  } catch (error) {
    return relayError(error);
  }
}
