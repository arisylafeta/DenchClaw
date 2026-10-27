import { guardRelay, relayError } from "@/lib/relay-route";
import { saveToGmailDrafts } from "@/lib/relay";
import { gmailDraftUrl } from "@/lib/gmail-drafts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

/** "Add to Gmail drafts": copies the draft into alex@'s Gmail drafts, threaded as a reply. Gmail sending stays blocked. */
export async function POST(_req: Request, { params }: Context) {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  try {
    const { gmailDraftId } = await saveToGmailDrafts(id, guard.user.id);
    return Response.json({ gmailDraftId, url: gmailDraftUrl("alex@rebattery.io", null) });
  } catch (error) {
    return relayError(error);
  }
}
