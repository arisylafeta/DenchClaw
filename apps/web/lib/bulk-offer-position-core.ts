import { CHASE_AFTER_WORKING_DAYS, londonDate, workingDaysBetween } from "./match/working-days";

/**
 * Where an offer stands, the pure part: whose move it is, the price on the table, how far the deal has got, and a stage
 * the newest messages suggest. Whose move is read from the messages themselves (email and WhatsApp), not from a stored
 * flag, so it cannot go stale. A move set by hand counts until a newer message arrives.
 */

export type OfferSide = "seller" | "buyer";
export type PositionMessage = { id: string; channel: "mail" | "whatsapp"; direction: "inbound" | "outbound" | null; at: string; subject: string | null; text: string };
/** A move set by hand, and when. Only one set in the CRM counts: an older stored flag without a time is ignored. */
export type MoveOverride = { who: "us" | "them"; at: string } | null;
export type Turn = "us" | "them" | "closed";
export type Position = {
  turn: Turn;
  since: string | null;
  /** Calendar days since `since`, in London. */
  days: number;
  /** Why Relay thinks so, in a line. */
  reason: string;
  chase: boolean;
  /** What happens next, when the turn alone says it (a chase, an answer owed). */
  next: string | null;
  source: "message" | "promise" | "none" | "manual" | "saved" | "closed";
};

const CLOSED = new Set(["complete", "declined", "lost"]);
const CHASEABLE = new Set(["candidate", "offered", "negotiating", "contract_out", "signed", "invoiced"]);
const DAY = 86_400_000;

/** "28 Oct", in London. */
export function dayMonth(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", day: "numeric", month: "short" }).format(new Date(iso));
}

const AUTO_SUBJECT = /^\s*(?:automatic reply|auto[- ]?reply|autoreply|out of (?:the )?office|abwesenheit|afwezig|autosvar|automatisch antwoord|réponse automatique)\b/i;
const AUTO_TEXT = /^\s*(?:(?:hi|hello|dear)[^\n]{0,40}\n+)?(?:i am|i'm|i’m) (?:currently )?(?:out of (?:the )?office|away|on (?:annual )?leave)\b/i;
/** An out-of-office or other automatic answer: it is not them taking their turn. */
export const isAutoReply = (m: Pick<PositionMessage, "subject" | "text">) => AUTO_SUBJECT.test(m.subject ?? "") || AUTO_TEXT.test(m.text);

const QUOTE_INLINE = /\s(?:On (?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?[^\n]{0,160}?wrote:|From: [^\n]{0,200}?(?:Sent|Date): )[\s\S]*$/;
const QUOTE_LINE = /^(?:>|on .{4,200} wrote:\s*$|-{2,}\s*original message|_{5,}\s*$)/i;
const OUTLOOK_HEAD = /^(?:from|van|von|de|fra):\s/i;
const SIGNATURE = /^--\s*$/;
const SIGN_OFF = /^(?:best|regards|kind regards|best regards|warm regards|many thanks|thanks|thank you|cheers|sincerely|br|all the best|met vriendelijke groet(?:en)?|mvg|mit freundlichen grüßen|vennlig hilsen|med vennlig hilsen)\b[^.!?]{0,30}$/i;
const GREETING = /^(?:hi|hello|hey|dear|morning|afternoon|good (?:morning|afternoon|evening)|hallo|goedemorgen|goedemiddag|beste|hej|hei)\b[^.!?\n]{0,40}[,!:]?$/i;
const JUNK = /\[(?:cid|image):[^\]]*\]|<(?:mailto:|https?:\/\/)[^>]*>/gi;

/**
 * What someone wrote in a message, without the greeting, the sign-off, the signature or the earlier messages quoted
 * under it. Their words are kept as written: nothing is reworded.
 */
export function cleanMessage(text: string | null | undefined): string {
  const lines = (text ?? "").replace(/\r\n/g, "\n").replace(JUNK, "").split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (QUOTE_LINE.test(line) || SIGNATURE.test(lines[i])) break;
    // An Outlook header block: From:, then Sent: or Date: within the next lines.
    if (OUTLOOK_HEAD.test(line) && lines.slice(i + 1, i + 4).some((l) => /^(?:sent|date|verzonden|gesendet|to|aan|an):\s/i.test(l.trim()))) break;
    if (kept.some((l) => l) && SIGN_OFF.test(line)) break;
    if (!kept.some((l) => l) && (!line || GREETING.test(line))) continue;
    kept.push(line);
  }
  return kept.join("\n").replace(QUOTE_INLINE, "").replace(/\n{3,}/g, "\n\n").trim();
}

const PROMISE = /\b(?:i|we)(?:['’]ll| will| shall)\s+(?:come back|get back|be back in touch|be in touch|revert|follow up|firm up|update you|let you know|confirm|send (?:you|over|through|it|the|a|an)|have (?:a|an|the) (?:offer|price|quote|answer))\b/i;

/** The sentence in our message that promises them something ("I'll come back to you…"), or null. */
export function promiseIn(text: string): string | null {
  const sentence = cleanMessage(text).split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).find((s) => PROMISE.test(s));
  if (!sentence) return null;
  return sentence.length > 140 ? `${sentence.slice(0, 140).replace(/\s+\S*$/, "")}…` : sentence;
}

const channelWord = (m: PositionMessage) => (m.channel === "whatsapp" ? "WhatsApp" : "email");

/**
 * Whose move it is. Closed stages are closed. A move set by hand counts until a newer message. Otherwise the newest
 * real message decides: theirs, or ours with a promise in it, is our move; ours without one is theirs, and after
 * three working days with no answer it is due a chase (unless chasing was switched off since).
 */
export function whoseMove(input: {
  stage: string | null; messages: PositionMessage[]; override: MoveOverride; chaseOffAt?: string | null; now?: Date;
  /** A status saved before whose move was read from the messages: used only when no message is linked at all. */
  saved?: { who: "us" | "them"; since: string | null } | null;
}): Position {
  const now = input.now ?? new Date();
  const days = (iso: string | null) => (iso ? Math.max(0, Math.round((Date.parse(londonDate(now)) - Date.parse(londonDate(iso))) / DAY)) : 0);
  if (input.stage && CLOSED.has(input.stage)) return { turn: "closed", since: null, days: 0, reason: "Closed.", chase: false, next: null, source: "closed" };
  const live = input.messages
    .filter((m) => m.direction && !Number.isNaN(Date.parse(m.at)) && !(m.direction === "inbound" && isAutoReply(m)))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const newest = live[0];
  const chaseable = !input.stage || CHASEABLE.has(input.stage);
  const chaseOff = (since: string) => !!input.chaseOffAt && Date.parse(input.chaseOffAt) >= Date.parse(since);
  const waiting = (since: string, reason: string, source: Position["source"]): Position => {
    const n = workingDaysBetween(since, now);
    const chase = chaseable && n >= CHASE_AFTER_WORKING_DAYS && !chaseOff(since);
    return { turn: "them", since, days: days(since), reason: chase ? `${reason} No reply in ${n} working days.` : reason, chase,
      next: chase ? `Chase: no reply since ${dayMonth(since)}.` : "Waiting for their reply.", source };
  };
  if (input.override && (!newest || Date.parse(input.override.at) >= Date.parse(newest.at))) {
    const reason = `Set by hand on ${dayMonth(input.override.at)}.`;
    if (input.override.who === "them") return waiting(input.override.at, reason, "manual");
    return { turn: "us", since: input.override.at, days: days(input.override.at), reason, chase: false, next: null, source: "manual" };
  }
  if (!newest) {
    if (input.saved) {
      const reason = "No email or WhatsApp linked. Going by the saved status.";
      if (input.saved.who === "them" && input.saved.since) return waiting(input.saved.since, reason, "saved");
      return { turn: input.saved.who, since: input.saved.since, days: days(input.saved.since), reason, chase: false, next: null, source: "saved" };
    }
    if (!input.stage || input.stage === "candidate") return { turn: "us", since: null, days: 0, reason: "Nothing sent yet.", chase: false, next: "Make first contact.", source: "none" };
    return { turn: "us", since: null, days: 0, reason: "No email or WhatsApp linked to this offer.", chase: false, next: "Link their email or WhatsApp, or set whose move.", source: "none" };
  }
  const when = dayMonth(newest.at);
  if (newest.direction === "inbound") {
    return { turn: "us", since: newest.at, days: days(newest.at), reason: `Their ${channelWord(newest)} on ${when} is the newest message.`, chase: false,
      next: `Answer their ${channelWord(newest)} of ${when}.`, source: "message" };
  }
  const promised = promiseIn(newest.text);
  if (promised) {
    return { turn: "us", since: newest.at, days: days(newest.at), reason: `You wrote on ${when}: “${promised}”`, chase: false,
      next: `Come back to them as you said on ${when}.`, source: "promise" };
  }
  return waiting(newest.at, `You wrote on ${when}.`, "message");
}

/** The next step to show: the stored one while it is newer than the newest message, else what the turn says. */
export function nextStep(stored: { text: string | null; at: string | null }, position: Position, newestAt: string | null): string | null {
  if (position.turn === "closed") return null;
  const fresh = !!stored.text && (!newestAt || (!!stored.at && Date.parse(stored.at) >= Date.parse(newestAt)));
  if (position.turn === "them") return position.next;
  return fresh ? stored.text : position.next ?? stored.text;
}

// ---------------------------------------------------------------- Price

type Terms = Record<string, unknown>;
export type PricePart = { label: string; value: string; note: string | null; kind: "theirs" | "ours" | "none" };
export type PriceLine = { parts: PricePart[]; gap: string | null };

const SYMBOL: Record<string, string> = { EUR: "€", GBP: "£", USD: "$" };
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d+(?:\.\d+)?$/.test(v.trim()) ? Number(v) : null);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const fmt = (n: number) => n.toLocaleString("en-GB", { maximumFractionDigits: 2 });
const unitOf = (u: unknown) => { const s = str(u); return s ? (/^kwh$/i.test(s) ? "kWh" : s) : null; };

/** "€4,250 / pack", "SEK 700 / kWh", "€55–58 / kWh". */
export function money(amount: number | [number, number], currency: string | null, unit: string | null): string {
  const code = (currency ?? "").toUpperCase();
  const figure = Array.isArray(amount) ? `${fmt(amount[0])}–${fmt(amount[1])}` : fmt(amount);
  const value = SYMBOL[code] ? `${SYMBOL[code]}${figure}` : code ? `${code} ${figure}` : figure;
  return unit ? `${value} / ${unit}` : value;
}

/** How firm a price is, in a few words: the first clause of what was stored. */
const firmness = (t: Terms) => { const f = str(t.firmness); return f ? f.split(/[:;(]/)[0].trim().slice(0, 40) : null; };
const dated = (note: string | null, on: unknown) => { const d = str(on); const day = d && /^\d{4}-\d{2}-\d{2}/.test(d) ? dayMonth(`${d.slice(0, 10)}T12:00:00Z`) : null; return [note, day].filter(Boolean).join(" · ") || null; };

/** Their price, in whichever shape it was stored: one figure, a range, a per-kWh figure, or a list of items. */
function theirAsk(t: Terms): { value: string; amount: number | null } | null {
  const currency = str(t.currency);
  const unit = unitOf(t.unit);
  const amount = num(t.amount);
  if (amount != null) return { value: money(amount, currency, unit), amount };
  const low = num(t.amount_low) ?? num(t.min);
  const high = num(t.amount_high) ?? num(t.max);
  if (low != null && high != null) return { value: money([low, high], currency, unit), amount: null };
  const perKwh = num(t.eur_per_kwh);
  if (perKwh != null) return { value: money(perKwh, "EUR", "kWh"), amount: null };
  if (Array.isArray(t.items)) {
    const priced = t.items.map((x) => (x && typeof x === "object" ? x as Terms : {})).filter((x) => num(x.amount) != null).slice(0, 2);
    if (priced.length) return { value: priced.map((x) => `${money(num(x.amount)!, str(x.currency) ?? currency, unitOf(x.unit) ?? unit)}${str(x.model) ? ` ${str(x.model)!.split(/[,(]/)[0].trim()}` : ""}`).join(" · "), amount: null };
  }
  return null;
}

/** Their budget or target, for a buyer. */
function budget(t: Terms): string | null {
  const currency = str(t.currency);
  const unit = unitOf(t.unit);
  const target = num(t.buyer_target) ?? num(t.budget);
  if (target != null) return money(target, currency, unit);
  if (t.buyer_budget && typeof t.buyer_budget === "object") {
    const [key, b] = Object.entries(t.buyer_budget as Terms)[0] ?? [];
    const r = b && typeof b === "object" ? b as Terms : null;
    const low = r ? num(r.low) : null; const high = r ? num(r.high) : null;
    if (low != null && high != null) return `${money([low, high], currency, unit)} (${String(key).toUpperCase()})`;
  }
  return null;
}

/**
 * The price on the table, as the row shows it. A seller: what they ask, then what we bid (or asked them to reach), and
 * how far apart when both are one figure in one unit. A buyer: our price, then their budget.
 */
export function priceLine(terms: Terms | null | undefined, side: OfferSide): PriceLine | null {
  const t = terms ?? {};
  const currency = str(t.currency);
  const unit = unitOf(t.unit);
  const bid = t.our_bid && typeof t.our_bid === "object" ? t.our_bid as Terms : null;
  const asked = t.our_ask && typeof t.our_ask === "object" ? t.our_ask as Terms : null;
  const ours: PricePart | null = bid && num(bid.amount) != null
    ? { label: "You bid", value: money(num(bid.amount)!, str(bid.currency) ?? currency, unit), note: dated(null, bid.on), kind: "ours" }
    : asked && num(asked.amount) != null
      ? { label: "You asked for", value: money(num(asked.amount)!, str(asked.currency) ?? currency, unit), note: dated(null, asked.asked_on), kind: "ours" }
      : null;
  const ask = theirAsk(t);
  if (side === "seller") {
    if (!ask && !ours) return null;
    const parts: PricePart[] = [ask ? { label: "They ask", value: ask.value, note: dated(firmness(t), t.stated_on), kind: "theirs" } : { label: "They ask", value: "no price yet", note: null, kind: "none" }];
    parts.push(ours ?? { label: "You bid", value: "not yet", note: null, kind: "none" });
    const bidAmount = bid ? num(bid.amount) : null;
    const sameCurrency = !bid || !str(bid.currency) || str(bid.currency) === currency;
    const gap = ask?.amount != null && bidAmount != null && sameCurrency && ask.amount !== bidAmount ? `${money(Math.abs(ask.amount - bidAmount), currency, null)} apart` : null;
    return { parts, gap };
  }
  const theirs = budget(t);
  const price = ask ? { label: "Your price", value: ask.value, note: dated(firmness(t), t.stated_on), kind: "ours" as const } : ours;
  if (!price && !theirs) return null;
  const parts: PricePart[] = [price ?? { label: "Your price", value: "not yet", note: null, kind: "none" }];
  if (theirs) parts.push({ label: "Their budget", value: theirs, note: dated(null, t.buyer_target_on), kind: "theirs" });
  const target = num(t.buyer_target) ?? num(t.budget);
  const gap = ask?.amount != null && target != null && ask.amount !== target ? `${money(Math.abs(ask.amount - target), currency, null)} apart` : null;
  return { parts, gap };
}

/** The dated price moves the stored terms hold, oldest first. Logged price changes are added from the thread. */
export function priceMoves(terms: Terms | null | undefined, side: OfferSide): { at: string; who: string; text: string }[] {
  const t = terms ?? {};
  const out: { at: string; who: string; text: string }[] = [];
  const day = (v: unknown) => { const s = str(v); return s && /^\d{4}-\d{2}-\d{2}/.test(s) ? `${s.slice(0, 10)}T12:00:00Z` : null; };
  const ask = theirAsk(t);
  const stated = day(t.stated_on);
  if (ask && stated) out.push({ at: stated, who: side === "seller" ? "They" : "You", text: `priced it at ${ask.value}${firmness(t) ? ` (${firmness(t)})` : ""}.` });
  const bid = t.our_bid && typeof t.our_bid === "object" ? t.our_bid as Terms : null;
  if (bid && num(bid.amount) != null && day(bid.on)) out.push({ at: day(bid.on)!, who: "You", text: `bid ${money(num(bid.amount)!, str(bid.currency) ?? str(t.currency), unitOf(t.unit))}.` });
  const asked = t.our_ask && typeof t.our_ask === "object" ? t.our_ask as Terms : null;
  if (asked && num(asked.amount) != null && day(asked.asked_on)) out.push({ at: day(asked.asked_on)!, who: "You", text: `asked for ${money(num(asked.amount)!, str(asked.currency) ?? str(t.currency), unitOf(t.unit))}.` });
  const target = num(t.buyer_target);
  if (target != null && day(t.buyer_target_on)) out.push({ at: day(t.buyer_target_on)!, who: "They", text: `set a target of ${money(target, str(t.currency), unitOf(t.unit))}.` });
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

// ---------------------------------------------------------------- How far it has got

export type Step = { label: string; state: "done" | "now" | "todo" };
const RANK = ["candidate", "offered", "negotiating", "contract_out", "signed", "invoiced", "paid", "complete"];
const rank = (stage: string | null) => RANK.indexOf(stage ?? "candidate");

/**
 * How far the deal has got, from the existing stages and the stored prices. A seller: Asked, They priced, You bid,
 * Agreed, Bought. A buyer: Asked, Priced, Agreed, Invoiced, Paid, Complete. Every step up to the furthest one reached
 * counts as done.
 */
export function ladder(input: { stage: string | null; terms: Terms | null | undefined; side: OfferSide; contacted: boolean }): Step[] {
  const t = input.terms ?? {};
  const r = rank(input.stage);
  const agreed = r >= rank("contract_out");
  const reached = input.side === "seller"
    ? [input.contacted || r >= rank("offered"), !!theirAsk(t), !!(t.our_bid && typeof t.our_bid === "object"), agreed, r >= rank("paid")]
    : [input.contacted || r >= rank("offered"), !!theirAsk(t) || !!t.our_ask || r >= rank("negotiating"), agreed, r >= rank("invoiced"), r >= rank("paid"), r >= rank("complete")];
  const labels = input.side === "seller" ? ["Asked", "They priced", "You bid", "Agreed", "Bought"] : ["Asked", "Priced", "Agreed", "Invoiced", "Paid", "Complete"];
  const furthest = reached.lastIndexOf(true);
  return labels.map((label, i) => ({ label, state: i <= furthest ? "done" : i === furthest + 1 ? "now" : "todo" }));
}

// ---------------------------------------------------------------- Stage the messages suggest

export type StageHint = { stage: "signed" | "invoiced" | "paid"; messageId: string; at: string; channel: "mail" | "whatsapp"; quote: string };

const PAID = /(?:^|[\s!.,"“])(?:paid!?|we(?:['’]ve| have) paid|has been paid|payment (?:has been |was |is )?(?:made|sent|completed|done)|(?:money|funds|payment) (?:has been |was )?transferred)(?=$|[\s!.,"”])/i;
const NOT_PAID = /\b(?:will be paid|once paid|when paid|not (?:yet )?(?:been )?paid|be paid|get paid|unpaid|to be paid|before (?:we )?pa(?:y|id))\b/i;
const INVOICE = /\binvoice\b/i;
const ATTACHED = /\b(?:attached|attach(?:ing)?|please (?:find|see))\b/i;
const SIGNED = /\b(?:signed (?:contract|agreement|copy|version)|(?:contract|agreement) (?:is |has been )?signed|attached the signed)\b/i;
const NOT_SIGNED = /\b(?:to be signed|once signed|please sign|for signature|not (?:yet )?signed)\b/i;

/** The sentence a match sits in, for the suggestion's quote. */
function sentenceAt(text: string, pattern: RegExp): string {
  const parts = text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  const found = parts.find((s) => pattern.test(s)) ?? parts[0] ?? "";
  const hit = found.replace(/^(?:hi|hello|hey|dear|hallo)\b[^,!.]{0,30}[,!]\s*(?=\S)/i, "");
  return hit.length > 140 ? `${hit.slice(0, 140).replace(/\s+\S*$/, "")}…` : hit;
}

/**
 * A stage the newest messages point to, further on than the one stored: "Paid!" from them, our email with the invoice
 * attached, a signed contract. Only a suggestion: a person confirms it. `skipped` is the message a "Not yet" was for.
 */
export function stageHint(input: { stage: string | null; messages: PositionMessage[]; skipped: string | null }): StageHint | null {
  if (input.stage && CLOSED.has(input.stage)) return null;
  const newest = [...input.messages].filter((m) => m.direction).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 4);
  let best: StageHint | null = null;
  for (const m of newest) {
    if (m.id === input.skipped) continue;
    const text = cleanMessage(m.text);
    const found: StageHint["stage"] | null =
      m.direction === "inbound" && PAID.test(text) && !NOT_PAID.test(text) ? "paid"
      : m.direction === "outbound" && INVOICE.test(`${m.subject ?? ""} ${text}`) && ATTACHED.test(text) ? "invoiced"
      : SIGNED.test(text) && !NOT_SIGNED.test(text) ? "signed" : null;
    if (!found || rank(found) <= rank(input.stage) || (best && rank(best.stage) >= rank(found))) continue;
    const pattern = found === "paid" ? PAID : found === "invoiced" ? INVOICE : SIGNED;
    best = { stage: found, messageId: m.id, at: m.at, channel: m.channel, quote: sentenceAt(text, pattern) };
  }
  return best;
}
