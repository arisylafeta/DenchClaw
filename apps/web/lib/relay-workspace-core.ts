import type { RankBand, WaitingRow } from "./relay-rank-core";
import type { Mark, SendMode } from "./relay-talk-core";
import type { PriceFill } from "./relay-price-types";
import type { TalkDraft } from "./relay-talk";
import { priceGapRef } from "./relay-price-core";
import { fillGaps, segments, type Segment } from "./relay-ways-core";
import { sendLabel, UNDO_SEND_SECONDS } from "./relay-send-time";

/**
 * The new Relay workspace, the pure part: the "Waiting on you" list by band, a draft's body as pieces (text, lime
 * marks, price fields and other gaps) in paragraphs, and the Send gate. The page (relay-workspace*.tsx) only draws these.
 */

// ---------- the list ----------

export const BAND_LABEL: Record<RankBand, string> = { now: "Now", today: "Today", week: "This week", later: "Later" };
export type Bands = Record<RankBand, WaitingRow[]>;
export type ListEntry =
  | { kind: "head"; band: RankBand; label: string; n: number }
  | { kind: "row"; row: WaitingRow }
  | { kind: "more"; band: RankBand; n: number }
  | { kind: "fold"; band: RankBand; label: string; n: number; open: boolean };

/** True when the row's name, company or ask holds every word of the search. */
export function matchesRow(row: Pick<WaitingRow, "name" | "company" | "ask">, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = `${row.name} ${row.company ?? ""} ${row.ask}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

/**
 * The list as the page draws it: Now in full, Today up to `todayLimit` with "N more today", This week and Later folded
 * until opened. A search shows every match in every band, unfolded.
 */
export function listEntries(bands: Bands, { open = {}, query = "", todayLimit = 8 }: { open?: Partial<Record<RankBand, boolean>>; query?: string; todayLimit?: number } = {}): ListEntry[] {
  const q = query.trim();
  const rows = (band: RankBand) => (q ? bands[band].filter((r) => matchesRow(r, q)) : bands[band]);
  const out: ListEntry[] = [];
  for (const band of ["now", "today"] as const) {
    const all = rows(band);
    if (!all.length) continue;
    out.push({ kind: "head", band, label: BAND_LABEL[band], n: all.length });
    const shown = band === "today" && !q && !open.today ? all.slice(0, todayLimit) : all;
    for (const row of shown) out.push({ kind: "row", row });
    if (shown.length < all.length) out.push({ kind: "more", band, n: all.length - shown.length });
  }
  for (const band of ["week", "later"] as const) {
    const all = rows(band);
    if (!all.length) continue;
    const isOpen = !!q || !!open[band];
    out.push({ kind: "fold", band, label: BAND_LABEL[band], n: all.length, open: isOpen });
    if (isOpen) for (const row of all) out.push({ kind: "row", row });
  }
  return out;
}

/** The rows J and K move through: the ones on screen, in order. */
export const visibleRows = (entries: ListEntry[]) => entries.flatMap((e) => (e.kind === "row" ? [e.row] : []));

/** "7 d" is 7, "today" is 0. */
export const waitedDays = (label: string) => (/^\d+/.test(label) ? parseInt(label, 10) : 0);

/** The tone of a row's cue: a late promise in red, a ready draft in the accent, the rest in ink. */
export const tagTone = (tag: string | null): "err" | "acc" | "ink" => (tag === "Promise overdue" ? "err" : tag === "Draft ready" ? "acc" : "ink");

// ---------- the body ----------

export type GapSpan = { start: number; end: number; index: number; label: string; priceKey: string | null };

/** Stands in for one gap while finding where it sits: a private-use character no email carries. */
const PROBE = "";

/**
 * Where each gap sits in the body, in characters. relay-ways-core reads the gaps; filling one gap at a time with a probe
 * finds its place, so the page and the server always agree on what a gap is.
 */
export function gapSpans(body: string): GapSpan[] {
  if (body.includes(PROBE)) return [];
  return segments(body).flatMap((s: Segment) => {
    if (!("gap" in s)) return [];
    const values: string[] = [];
    values[s.index] = PROBE;
    const filled = fillGaps(body, values);
    const start = filled.indexOf(PROBE);
    if (start < 0) return [];
    return [{ start, end: start + body.length - (filled.length - PROBE.length), index: s.index, label: s.gap, priceKey: priceGapRef(s.gap) }];
  });
}

/** "VW ID.3 62 kWh, 2020" from "price for VW ID.3 62 kWh, 2020 (ref stock:…)". */
export const priceLabel = (gap: string) => gap.replace(/\(ref [^)]*\)/i, "").replace(/^price (?:for|of)\s+/i, "").trim();

export type Piece =
  | { kind: "text"; text: string; marked: boolean }
  | { kind: "gap"; index: number; label: string; marked: boolean }
  | { kind: "price"; index: number; key: string; label: string; marked: boolean };
export type Paragraph = Piece[];

const overlaps = (marks: readonly Mark[], start: number, end: number) => marks.some((m) => m.end > m.start && m.start < end && m.end > start);

/** The body as text, gaps and price fields, with the text a change touched marked. A gap a change touched is marked too. */
export function bodyPieces(body: string, marks: readonly Mark[] = []): Piece[] {
  const gaps = gapSpans(body);
  const cuts = new Set<number>([0, body.length]);
  for (const m of marks) { if (m.end > m.start) { cuts.add(Math.max(0, Math.min(body.length, m.start))); cuts.add(Math.max(0, Math.min(body.length, m.end))); } }
  for (const g of gaps) { cuts.add(g.start); cuts.add(g.end); }
  const at = [...cuts].toSorted((a, b) => a - b);
  const out: Piece[] = [];
  for (let k = 0; k < at.length - 1; k++) {
    const [start, end] = [at[k], at[k + 1]];
    const gap = gaps.find((g) => g.start <= start && end <= g.end);
    if (gap) {
      if (gap.start !== start) continue;
      const marked = overlaps(marks, gap.start, gap.end);
      out.push(gap.priceKey ? { kind: "price", index: gap.index, key: gap.priceKey, label: priceLabel(gap.label), marked } : { kind: "gap", index: gap.index, label: gap.label, marked });
      continue;
    }
    const text = body.slice(start, end);
    const marked = overlaps(marks, start, end);
    const last = out[out.length - 1];
    if (last?.kind === "text" && last.marked === marked) last.text += text;
    else out.push({ kind: "text", text, marked });
  }
  return out;
}

/** The pieces in paragraphs, split at blank lines, so each paragraph can carry its notes in the margin. */
export function paragraphs(body: string, marks: readonly Mark[] = []): Paragraph[] {
  const out: Paragraph[] = [[]];
  for (const piece of bodyPieces(body.replace(/\r\n/g, "\n"), marks)) {
    if (piece.kind !== "text") { out[out.length - 1].push(piece); continue; }
    piece.text.split(/\n[ \t]*\n\s*/).forEach((text, k) => {
      if (k > 0) out.push([]);
      if (text) out[out.length - 1].push({ ...piece, text });
    });
  }
  // A paragraph's own leading or trailing line breaks are layout, not words.
  return out.map((p) => {
    const first = p[0];
    if (first?.kind === "text") first.text = first.text.replace(/^\n+/, "");
    const last = p[p.length - 1];
    if (last?.kind === "text") last.text = last.text.replace(/\s+$/, "");
    return p.filter((x) => x.kind !== "text" || x.text);
  }).filter((p) => p.length);
}

// ---------- prices and gaps ----------

/** "5,350" or "£5350" as whole pounds; empty clears the price. */
export function parsePrice(input: string): { value: number | null } | { error: string } {
  const text = input.replace(/[£,\s]/g, "");
  if (!text) return { value: null };
  if (!/^\d+(\.\d+)?$/.test(text)) return { error: "Type the price in pounds, like 5,350." };
  return { value: Math.round(Number(text)) };
}
export const priceText = (value: number | null | undefined) => (value == null ? "" : value.toLocaleString("en-GB"));

/** What a draft still needs before it can go. typed: what Alex has typed into its other gaps, by gap index. */
export type DraftNeeds = { emptyPrices: number; otherGaps: number; relayPrices: number; alexPrices: number };

export function draftNeeds(main: string, fills: readonly PriceFill[], typed: Readonly<Record<number, string>> = {}): DraftNeeds {
  const needs: DraftNeeds = { emptyPrices: 0, otherGaps: 0, relayPrices: 0, alexPrices: 0 };
  const seen = new Set<string>();
  for (const gap of gapSpans(main)) {
    if (!gap.priceKey) { if (!typed[gap.index]?.trim()) needs.otherGaps++; continue; }
    if (seen.has(gap.priceKey)) continue;
    seen.add(gap.priceKey);
    const fill = fills.find((f) => f.key === gap.priceKey);
    if (fill?.value == null) needs.emptyPrices++;
    else if (fill.by === "alex") needs.alexPrices++;
    else needs.relayPrices++;
  }
  return needs;
}

/** The small line under a draft's tab. */
export function tabNote(d: Pick<TalkDraft, "role" | "state" | "included" | "send_mode" | "send_at" | "mail" | "leaks">, needs: DraftNeeds, now = new Date()): { text: string; tone: "danger" | "warn" | "quiet" } {
  if (d.state === "sent") return { text: "Sent", tone: "quiet" };
  if (d.mail?.scheduled) return { text: d.mail.scheduled.undo ? "Sending" : `Goes ${sendLabel(d.mail.scheduled.at, now)}${d.mail.scheduled.unless_reply ? ", unless they reply" : ""}`, tone: "quiet" };
  if (d.leaks.length) return { text: "Can't go like this", tone: "danger" };
  if (d.role === "follow" && !d.included) return { text: "Not sending", tone: "quiet" };
  const empty = needs.emptyPrices + needs.otherGaps;
  if (empty) return { text: needs.otherGaps && !needs.emptyPrices ? `${empty} ${empty === 1 ? "gap" : "gaps"} to fill` : `${empty} ${empty === 1 ? "price" : "prices"} to fill`, tone: "warn" };
  if (needs.relayPrices) return { text: `${needs.relayPrices} ${needs.relayPrices === 1 ? "price" : "prices"} by Relay`, tone: "warn" };
  if (d.role === "follow") return { text: whenWords(d, now), tone: "quiet" };
  return { text: "Ready", tone: "quiet" };
}

export const SEND_MODE_WORDS: Record<SendMode, string> = { with_reply: "With the reply", at: "At a set time", unless_reply: "At a set time, unless they reply", after_order: "After they order" };

/** When a linked email goes, in a few words. */
export function whenWords(d: { send_mode: SendMode; send_at: string | null }, now = new Date()): string {
  if (d.send_mode === "with_reply") return "With the reply";
  if (d.send_mode === "after_order") return "After they order";
  if (!d.send_at) return "Pick a time";
  return d.send_mode === "unless_reply" ? `${sendLabel(d.send_at, now)}, unless they reply` : sendLabel(d.send_at, now);
}

// ---------- the Send gate ----------

export type Gate = {
  ready: boolean;
  /** "Send the reply and 2 more". */
  label: string;
  /** Why it can't go, or what to know before it does. */
  line: string;
  /** danger: a leak. block: something to fill or pick first. */
  tone: "danger" | "block" | "warn" | "ok";
  /** The drafts Send would take: the reply first, then the ticked linked emails. */
  going: TalkDraft[];
};

const n = (k: number, one: string, many: string) => (k === 1 ? one : many.replace("#", String(k)));

/**
 * "Send the reply and N more": ready only when the reply and every ticked linked email has a recipient, no open gap,
 * no leak and, for a timed one, a time. typed: what Alex has typed into the other gaps, by draft and gap index, not saved yet.
 */
export function sendGate(drafts: readonly TalkDraft[], typed: Readonly<Record<string, Readonly<Record<number, string>>>> = {}): Gate {
  const primary = drafts.find((d) => d.role === "primary");
  const linked = drafts.filter((d) => d.role === "follow" && d.included && d.state !== "sent" && d.mail && !d.mail.scheduled);
  const label = linked.length ? `Send the reply and ${linked.length} more` : "Send the reply";
  const stop = (line: string, tone: Gate["tone"] = "block"): Gate => ({ ready: false, label, line, tone, going: [] });
  if (!primary?.mail) return stop("No reply yet. Tell Relay how to answer.");
  if (primary.state === "sent") return stop("The reply has gone.", "ok");
  if (primary.mail.scheduled) return stop(primary.mail.scheduled.undo ? "The reply is sending." : "The reply is waiting to send.", "ok");
  const going = [primary, ...linked];
  const name = (d: TalkDraft) => (d.role === "primary" ? "The reply" : `“${d.title}”`);

  if (!primary.mail.to_emails.length) return stop("The reply has no recipient.");
  const leaking = going.find((d) => d.leaks.length);
  if (leaking) return stop(`${name(leaking)} ${leaking.leaks[0].text.replace(/^./, (c) => c.toLowerCase())} Ask Relay to take it out.`, "danger");
  const noTo = linked.find((d) => !d.mail?.to_emails.length);
  if (noTo) return stop(`${name(noTo)} has no recipient.`);

  const needs = going.map((d) => ({ d, needs: draftNeeds(d.mail!.main, d.fills, typed[d.id]) }));
  const prices = needs.reduce((k, x) => k + x.needs.emptyPrices, 0);
  const others = needs.reduce((k, x) => k + x.needs.otherGaps, 0);
  if (prices || others) {
    const where = needs.filter((x) => x.needs.emptyPrices + x.needs.otherGaps);
    const inLinked = where.length === 1 && where[0].d.role === "follow" ? ` in ${name(where[0].d)}` : "";
    if (!others) return stop(`Fill ${n(prices, "the empty price", "the # empty prices")}${inLinked} to send.`);
    if (!prices) return stop(`Fill ${n(others, "the gap", "the # gaps")}${inLinked} to send.`);
    return stop(`Fill ${n(prices, "the empty price", "the # empty prices")} and ${n(others, "the gap", "the # gaps")} to send.`);
  }
  // The server's own reading of the gaps wins when it still sees one the page doesn't (and nothing typed explains it).
  const serverGap = going.find((d) => d.gaps && !Object.values(typed[d.id] ?? {}).some((v) => v.trim()));
  if (serverGap) return stop(`${name(serverGap)} still has a gap to fill.`);
  const untimed = linked.find((d) => (d.send_mode === "at" || d.send_mode === "unless_reply") && !d.send_at);
  if (untimed) return stop(`Pick when ${name(untimed)} goes.`);

  const relay = needs.reduce((k, x) => k + x.needs.relayPrices, 0);
  const undo = `${UNDO_SEND_SECONDS} seconds to undo.`;
  if (relay) return { ready: true, label, line: `The yellow ${n(relay, "price is", "prices are")} Relay’s. Change any, or send. ${undo}`, tone: "warn", going };
  return { ready: true, label, line: `Ready. ${undo}`, tone: "ok", going };
}

/** The versions Send pins: every draft it takes, by id, at the mail version the page shows. */
export const versionsOf = (going: readonly TalkDraft[]) => Object.fromEntries(going.flatMap((d) => (d.mail ? [[d.id, d.mail.updated_at]] : [])));

// ---------- earlier emails: the scan's one-line summary over each full email

/** The day an email went, as the scan writes it ("03 Nov"), in London. */
export const dayMonth = (iso: string) => {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", day: "2-digit", month: "short" }).formatToParts(new Date(iso));
  return `${parts.find((p) => p.type === "day")?.value ?? ""} ${parts.find((p) => p.type === "month")?.value ?? ""}`;
};

export type EarlierRow<E> = { email: E; when: string; who: string; summary: string | null };

/**
 * Pairs the thread's earlier emails (newest first) with the scan's summaries by day and side (Alex or them), each
 * summary used once. An email the scan didn't summarise gets none, and the page shows its first line instead.
 */
export function earlierRows<E extends { direction: string; at: string; from_email: string | null }>(
  emails: readonly E[], summaries: readonly { who: string; when: string; summary: string }[], theirName: string,
): EarlierRow<E>[] {
  const left = summaries.map((s) => ({ ...s, day: s.when.trim().replace(/^(\d)\b/, "0$1").toLowerCase(), ours: /^alex\b/i.test(s.who.trim()) }));
  return emails.map((email) => {
    const when = dayMonth(email.at);
    const ours = email.direction === "outbound";
    const at = left.findIndex((s) => s.day === when.toLowerCase() && s.ours === ours);
    const match = at >= 0 ? left.splice(at, 1)[0] : null;
    // The scan writes "Ben, bbament@gmail.com": the name is enough here.
    return { email, when, who: ours ? "Alex" : match?.who.split(",")[0].trim() || theirName, summary: match?.summary ?? null };
  });
}

// ---------- editing a draft by hand: price markers become short placeholders and back

const PRICE_MARKER = /\[\s*BLANK\s*:\s*price for ([^\]]*?)\s*\(ref [^)\]]+\)\s*\]/gi;

/**
 * The draft as Alex edits it: each Relay price marker reads "[price: <label>]", the rest as written. `markers` maps
 * each placeholder back, so saving keeps Relay's prices; typing a figure over one makes that price his.
 */
export function toEditable(body: string): { text: string; markers: Record<string, string> } {
  const markers: Record<string, string> = {};
  const text = body.replace(PRICE_MARKER, (marker, label: string) => {
    let place = `[price: ${label.trim()}]`;
    for (let n = 2; markers[place] && markers[place] !== marker; n++) place = `[price: ${label.trim()} (${n})]`;
    markers[place] = marker;
    return place;
  });
  return { text, markers };
}

export const fromEditable = (text: string, markers: Readonly<Record<string, string>>) =>
  Object.entries(markers).reduce((t, [place, marker]) => t.split(place).join(marker), text);

/** Addresses typed in a To, Cc or Bcc box: commas, semicolons or spaces between them. */
export const addressList = (typed: string) => typed.split(/[\s,;]+/).map((a) => a.trim().replace(/^<|>$/g, "").toLowerCase()).filter(Boolean);

/** An address Relay can send to. */
export const isAddress = (a: string) => /^[^@\s,;<>()"']+@[^@\s,;<>()"']+\.[a-z]{2,}$/i.test(a);

// ---------- the deal line under the name

/** market: the lot is also on the marketplace, with where to see it live. */
export type DealLine = { type: "Bulk trade" | "Marketplace"; name: string; facts: string[]; closed: boolean; market: { label: string; url: string } | null };
type DealIn = { kind: string; summary: string | null; quantity: string | null; status: string; title?: string | null; location?: string | null; price?: string | null;
  auction_slug?: string | null; auction_status?: string | null; listing_id?: string | null };

const SITE = "https://www.rebattery.io";

/** Where a lot is live on the marketplace: its auction while that's published, else its listing. */
function marketOf(deal: DealIn): DealLine["market"] {
  if (deal.auction_slug && deal.auction_status === "published") return { label: "Marketplace auction", url: `${SITE}/marketplace/auctions/${encodeURIComponent(deal.auction_slug)}` };
  if (deal.listing_id) return { label: "Marketplace", url: `${SITE}/marketplace/${encodeURIComponent(deal.listing_id)}` };
  return null;
}

const num = (text: string) => Number(text.replace(/,/g, ""));
const energy = (kwh: number) => (kwh >= 1000 ? `${(kwh / 1000).toLocaleString("en-GB", { maximumFractionDigits: 1 })} MWh` : `${kwh.toLocaleString("en-GB", { maximumFractionDigits: 0 })} kWh`);

/** The whole lot's energy when the title gives one per-unit capacity and a count ("120x … 6.6kWh", "2x … 1.26MWh"). */
function lotEnergy(title: string, quantity: string | null): string | null {
  const unit = title.match(/(?<![\d.\-–+])(\d+(?:\.\d+)?)\s*([km])wh\b/i);
  const count = title.match(/^(\d[\d,]*)\s*x\b/i)?.[1] ?? quantity?.match(/^\s*(\d[\d,]*)\s+[a-z]/i)?.[1];
  // A range ("41-52kWh", "92-102x") has no one total.
  if (!unit || !count || /\d\s*[-–]\s*\d|\+\s*[km]wh/i.test(title) || /-|–|\bto\b/.test(quantity ?? "")) return null;
  const each = num(unit[1]) * (unit[2].toLowerCase() === "m" ? 1000 : 1);
  const n = num(count);
  return n > 1 && each > 0 && each <= 5000 ? energy(n * each) : null;
}

const STREETISH = /\b(?:road|rd|street|st|lane|avenue|ave|way|house|unit|workshop|centre|center|park|estate|ltd|limited|gmbh|inc|llc|building|floor|suite)\b/i;

/** Where a lot is, short: the town and the country, without street, postcode or notes in brackets. */
export function shortPlace(place: string | null | undefined): string {
  const parts = (place ?? "").replace(/\([^)]*\)/g, "").replace(/^\s*(?:delivery|collection|location)\s*:\s*/i, "")
    .split(",").map((p) => p.trim()).filter((p) => p && !/\d/.test(p) && !STREETISH.test(p));
  if (parts.length <= 2) return parts.join(", ");
  return `${parts[0]}, ${parts[parts.length - 1]}`;
}

/** A quantity as a fact: its first clause, kept short. */
const shortQuantity = (q: string | null | undefined) => {
  const first = (q ?? "").split(/[;(]/)[0].trim();
  return first.length > 40 ? `${first.slice(0, 39).trimEnd()}…` : first;
};

/** The asking price per unit from the deal's note, like "3,000 each" or "€120/kWh". Null when it isn't stated plainly. */
function askPrice(note: string | null | undefined): string | null {
  const m = (note ?? "").match(/(?:ask|asking|price|offer)[^:;]{0,20}:\s*([€$£]?\s?\d[\d,.]*\s?k?)\s*(?:per|\/)\s*(module|pack|unit|cell|battery|container|kwh)/i);
  if (!m) return null;
  const amount = m[1].replace(/\s+/g, "");
  return /kwh/i.test(m[2]) ? `${amount}/kWh` : `${amount} each`;
}

/**
 * What the line under the name says about the linked deal: the kind of trade as a tag, a short name, and the facts
 * Alex replies with: which side, the lot's energy, the asking price and where it is.
 */
export function dealLine(deal: DealIn | null | undefined, fallbackLabel: string): DealLine {
  const name = (deal?.title?.trim() || deal?.summary?.trim() || fallbackLabel.split(" · ")[0].replace(/…$/, "")).replace(/\s+/g, " ");
  if (!deal) return { type: "Bulk trade", name, facts: [], closed: false, market: null };
  const facts = [
    deal.kind === "supply" ? "selling" : deal.kind === "demand" ? "buying" : "",
    lotEnergy(name, deal.quantity) ?? (deal.title ? "" : shortQuantity(deal.quantity)),
    askPrice(deal.price) ?? "",
    shortPlace(deal.location),
  ].filter(Boolean);
  return { type: "Bulk trade", name, facts, closed: deal.status === "closed", market: deal.status === "closed" ? null : marketOf(deal) };
}

