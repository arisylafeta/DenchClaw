import { guardRelay, readBody, relayError } from "@/lib/relay-route";
import { relayDraftForOwner, settleItem } from "@/lib/relay";
import { readMailDraft } from "@/lib/crm-postgres/mail";
import { sameVersion, sendDraft } from "@/lib/mail-draft-actions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

/**
 * Sends one Relay draft through the CRM mail pipeline, only on Alex's explicit click (`confirm: true`) and only the
 * version he saw (`updated_at`). The item is done once its reply is sent.
 */
export async function POST(req: Request, { params }: Context) {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  const body = await readBody(req);
  if (body?.confirm !== true || typeof body.updated_at !== "string") return Response.json({ error: "confirm and updated_at required" }, { status: 400 });
  try {
    const relayDraft = await relayDraftForOwner(id, guard.user.id);
    if (!relayDraft?.mail_message_id) return Response.json({ error: "Not found" }, { status: 404 });
    const mail = await readMailDraft(relayDraft.mail_message_id, guard.user.id);
    if (!mail) return Response.json({ error: "Not found" }, { status: 404 });
    if (!sameVersion(mail.updated_at, body.updated_at)) return Response.json({ error: "This draft changed since you opened it. Reload to see the latest." }, { status: 409 });
    const result = await sendDraft(mail, guard.user.email);
    await settleItem(relayDraft.item_id);
    return Response.json(result);
  } catch (error) {
    return relayError(error);
  }
}
