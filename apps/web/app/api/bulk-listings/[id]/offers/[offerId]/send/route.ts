import { ALLOWED_EMAILS, currentUser } from "@/lib/auth";
import { getListing } from "@/lib/crm-postgres/bulk-listings";
import { linkOfferThread, markOfferSent, offerOutreach } from "@/lib/crm-postgres/bulk-offer-mail";
import { readMailDraft } from "@/lib/crm-postgres/mail";
import { DraftActionError, sameVersion, sendDraft } from "@/lib/mail-draft-actions";
import { badRequest, guardBulkTrades, notFound, readJson } from "@/lib/bulk-trades-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string; offerId: string }> };

/**
 * Sends one offer email through the existing draft sender, then moves the offer on and links the thread.
 *
 * The draft is the one the panel showed, and `updated_at` must be its current version, so an edit made after
 * the person looked cannot go out. Only a definite `{sent: true}` writes anything: a refusal, a failure or an
 * unknown outcome leaves the offer and the links exactly as they were and says so.
 */
export async function POST(req: Request, { params }: Context) {
  const guard = await guardBulkTrades();
  if ("response" in guard) { return guard.response; }
  const { id, offerId } = await params;
  if (!await getListing(id)) { return notFound("Listing"); }
  const body = await readJson(req) as { confirm?: unknown; updated_at?: unknown; draft_id?: unknown } | null;
  if (!body || body.confirm !== true || typeof body.updated_at !== "string") {
    return badRequest("Confirm the send and name the draft version you looked at.");
  }
  const outreach = await offerOutreach(id, offerId);
  if (!outreach) { return notFound("Offer"); }
  const draftId = typeof body.draft_id === "string" && body.draft_id ? body.draft_id : outreach.openDraftId;
  if (!draftId) { return badRequest("Draft the email first."); }
  const draft = await readMailDraft(draftId, guard.userId);
  if (!draft) { return notFound("Draft"); }
  if (!sameVersion(draft.updated_at, body.updated_at)) {
    return Response.json({ error: "This draft changed since you looked at it. Review it again before sending.", sent: false }, { status: 409 });
  }
  const recipient = (draft.to_emails ?? []).map((address) => address.trim().toLowerCase());
  if (outreach.email && !recipient.includes(outreach.email)) {
    return Response.json({ error: "This draft does not go to the offer's contact, so it was not sent from here.", sent: false }, { status: 409 });
  }
  const user = await currentUser();
  if (!user) { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  if (!ALLOWED_EMAILS.has(user.email.toLowerCase())) {
    return Response.json({ error: "Only Ari or Alex can send from here." }, { status: 403 });
  }

  try {
    const result = await sendDraft(draft, user.displayName);
    if (!result.sent) {
      return Response.json({ sent: false, warning: "The mail tool did not confirm the send. Nothing was changed; check the draft before trying again." }, { status: 502 });
    }
  } catch (error) {
    if (error instanceof DraftActionError) {
      // 409 is a refusal or a definite failure. 502 means the outcome is unknown: the copy may have gone.
      const unknown = error.status >= 500;
      const warning = unknown
        ? `The send outcome is unknown, so the offer was not changed. Check the thread before retrying. ${error.message}`.trim()
        : error.message;
      return Response.json({ sent: false, error: warning, warning }, { status: error.status });
    }
    throw error;
  }

  // Sent for certain from here on: link the thread, then move the stage forward only.
  const after = await readMailDraft(draftId, guard.userId);
  const threadId = after?.thread_id ?? draft.thread_id;
  let threadLinked = false;
  if (threadId) {
    await linkOfferThread(id, offerId, threadId, guard.email);
    threadLinked = true;
  }
  const marked = await markOfferSent(offerId, guard.userId);
  return Response.json({
    sent: true,
    threadLinked,
    moved: marked?.moved ?? false,
    stage: marked?.stage ?? null,
    warning: threadLinked ? null : "Sent, but the mail thread is not known yet. It is linked when the mail sync supplies it.",
  });
}
