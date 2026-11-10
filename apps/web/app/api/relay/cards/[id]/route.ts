import { guardRelay, readBody, relayError } from "@/lib/relay-route";
import { dismissLeadCard, logLeadSkip, retryLeadCard, saveLeadState } from "@/lib/relay-lead";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

/** One change to a card: Alex's choices as he makes them (`state`), "Not a lead" (`dismiss`), read it again (`retry`), or a skip to note. */
export async function PATCH(req: Request, { params }: Context) {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  const body = await readBody(req);
  try {
    if (body?.dismiss === true) await dismissLeadCard(id, guard.user.id);
    else if (body?.retry === true) await retryLeadCard(id, guard.user.id);
    else if (body?.skip === true) await logLeadSkip(id, guard.user.id);
    else if (body?.state && typeof body.state === "object") return Response.json({ state: await saveLeadState(id, guard.user.id, body.state) });
    else return Response.json({ error: "state, dismiss, retry or skip required" }, { status: 400 });
    return Response.json({ ok: true });
  } catch (error) {
    return relayError(error);
  }
}
