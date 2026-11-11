/**
 * Replies to Jules, the pure part. Jules, the marketplace's listing helper, emails sellers from supply@ and their
 * answers come back to that inbox, so they sit in Relay next to Alex's own mail. An hourly Hermes job reads those
 * answers and puts plain facts onto the listing. This says, for one email, whether it is such an answer and how far
 * the job got with it, read from the job's own notes. Relay never writes to them.
 *
 * added: the job applied it. read: the job matched it to a chat and added nothing. unmatched: the job could not tell
 * which chat it belongs to. unread: it looks like an answer to Jules and the job has not been past it yet. skipped: it
 * looks like an answer to Jules and the job went past it without a note, as it does when the chat has no follow-up open.
 */

export type JulesState = "added" | "read" | "unmatched" | "unread" | "skipped";
export type JulesReply = {
  state: JulesState;
  /** The Jules chat the answer belongs to, when the job matched one. */
  conversation_id: string | null;
  /** The email has files. The job never opens them, so photos do not reach the listing. */
  files: boolean;
  /** When the job last ran. */
  checked_at: string | null;
};

/** The job's notes: how far it has read, and what became of each answer it found. Values are the Jules chat, when known. */
export type JulesWatch = { cursor: [string, string] | null; applied: Set<string>; pending: Map<string, string | null>; unmatched: Map<string, string | null> };

/** Their newest email on a thread. unread: it arrived after the last email the job has been past. ours: the email it
 * answers went out from the CRM, which sends through Postmark from supply@ as well, so it is not an answer to Jules. */
export type JulesMail = { id: string; subject: string | null; in_reply_to: string | null; rfc_references: string | null; to: string[]; has_attachments: boolean; unread: boolean; ours: boolean };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const chat = (v: unknown) => (typeof v === "string" && UUID.test(v) ? v.toLowerCase() : null);
const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** The job's notes as read from its file, or null when they are not notes Relay can trust. */
export function parseJulesWatch(raw: unknown): JulesWatch | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.applied) || !o.pending || typeof o.pending !== "object") return null;
  const c = o.cursor;
  const cursor: JulesWatch["cursor"] = Array.isArray(c) && typeof c[0] === "string" && typeof c[1] === "string" && !Number.isNaN(Date.parse(c[0])) ? [c[0], c[1]] : null;
  const pending = new Map(Object.entries(record(o.pending)).map(([id, job]): [string, string | null] => [id, chat(record(job).conversation_id)]));
  const unmatched = new Map(Object.entries(record(o.needs_human)).map(([id, job]): [string, string | null] => {
    const candidates = record(job).candidate_conversations;
    return [id, Array.isArray(candidates) && candidates.length === 1 ? chat(candidates[0]) : null];
  }));
  return { cursor, applied: new Set(o.applied.filter((id): id is string => typeof id === "string")), pending, unmatched };
}

/** Jules writes "Your <battery> packs" (or modules, cells, batteries; a draft with no name gives "Your packs"), "Your
 * <battery> listing is ready" and "We've received your <battery> details". No colon in the name: "Your offer was
 * accepted: <listing>" is the marketplace's own email, not Jules's. */
const JULES_SUBJECT = /^\s*(?:(?:re|aw|sv|antw|tr|fwd?)\s*:\s*)+(?:your\s(?:[^:]+\s)?(?:packs|modules|cells|batteries|listing is ready)|we['’]ve received your\s[^:]+\sdetails)\s*$/i;
const JULES_INBOXES = ["supply@rebattery.io", "support@rebattery.io"];

/** An email the job has no note on that reads as an answer to Jules: sent to the inbox Jules writes from, in reply to
 * an email that went out through Postmark and not from the CRM, under one of Jules's subjects. The references stand in
 * only when the email does not say what it answers: an answer to Alex's own reply on a Jules thread is his. */
export function looksLikeJulesReply(mail: Pick<JulesMail, "subject" | "in_reply_to" | "rfc_references" | "to" | "ours">): boolean {
  return !mail.ours
    && mail.to.some((a) => JULES_INBOXES.includes(a.trim().toLowerCase()))
    && /@mtasv\.net\b/i.test(mail.in_reply_to?.trim() || (mail.rfc_references ?? ""))
    && JULES_SUBJECT.test(mail.subject ?? "");
}

/** What the job made of this email, or null when it is not an answer to Jules. Without the job's notes nothing is
 * flagged: Relay does not guess. */
export function julesReply(mail: JulesMail, watch: JulesWatch | null, checkedAt: string | null): JulesReply | null {
  if (!watch) return null;
  const found = (state: JulesState, conversation_id: string | null): JulesReply => ({ state, conversation_id, files: mail.has_attachments, checked_at: checkedAt });
  // The job's own order: an email it applied is never queued again.
  if (watch.applied.has(mail.id)) return found("added", null);
  if (watch.pending.has(mail.id)) return found("read", watch.pending.get(mail.id) ?? null);
  // The job notes any email from a seller it is chasing, so one that answers the CRM's own email is not Jules's.
  if (watch.unmatched.has(mail.id)) return mail.ours ? null : found("unmatched", watch.unmatched.get(mail.id) ?? null);
  // In none of the lists: not read yet when it came in after the job's last read, passed over when before.
  return looksLikeJulesReply(mail) ? found(mail.unread ? "unread" : "skipped", null) : null;
}

/** The chat's page in the marketplace's operations pages. */
export function julesChatUrl(conversationId: string | null | undefined): string | null {
  return conversationId && UUID.test(conversationId) ? `https://www.rebattery.io/operations/jules/${conversationId}` : null;
}

export type JulesWords = { chip: string; tone: "ok" | "amber" | "grey"; line: string };

/** How a row says it. `ago` is how long since the job last ran, as the rows write it ("40 min"). */
export function julesWords(reply: JulesReply, ago = ""): JulesWords {
  const files = reply.files ? " It has files attached: Jules does not open them, so photos have to be added to the listing by hand." : "";
  switch (reply.state) {
    case "added": return { chip: "Added by Jules", tone: "ok", line: `Jules read this and took it in: what they wrote is on their listing, or their follow-ups are stopped if they asked for that. Reply only if they ask something else.${files}` };
    case "read": return { chip: "Read by Jules, not added", tone: "amber", line: `Jules read this and found nothing it could add by itself, like a question or an answer that is not clear. It needs a person.${files}` };
    case "unmatched": return { chip: "Jules could not place it", tone: "amber", line: `Jules could not tell which chat this belongs to, so nothing was added. It needs a person.${files}` };
    case "skipped": return { chip: "Not picked up by Jules", tone: "amber", line: `This answers a Jules email, but Jules passed over it, most likely because that chat has no follow-up open any more. Nothing was added. It needs a person.${files}` };
    default: return { chip: "Not read by Jules yet", tone: "grey", line: `Jules reads replies once an hour${ago ? `, last ${ago} ago` : ""}. This one came in after that.${files}` };
  }
}
