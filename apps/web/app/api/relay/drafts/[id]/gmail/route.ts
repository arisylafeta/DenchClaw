import { guardRelay, readBody, relayError } from "@/lib/relay-route";
import { readSeenFills, saveToGmailDrafts } from "@/lib/relay";
import { gmailDraftUrl } from "@/lib/gmail-drafts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

/**
 * "Add to Gmail drafts": copies the draft into alex@'s Gmail drafts, threaded as a reply. Gmail sending stays blocked.
 * Relay's prices go into the draft first, so the Gmail copy carries them; optional `fills` ([{ key, value }]) refuses
 * it if they changed since the page showed them.
 */
export async function POST(req: Request, { params }: Context) {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  const fills = readSeenFills((await readBody(req))?.fills);
  if ("error" in fills) return Response.json({ error: fills.error }, { status: 400 });
  try {
    const { gmailDraftId } = await saveToGmailDrafts(id, guard.user.id, fills.seen);
    return Response.json({ gmailDraftId, url: gmailDraftUrl("alex@rebattery.io", null) });
  } catch (error) {
    return relayError(error);
  }
}
