"use client";

import { ChevronDown, ChevronRight, ExternalLink, FileText, Mail, MessageCircle, Phone, Plus, StickyNote, Tag, ArrowDownLeft, ArrowUpRight } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { Offer, OfferStage, ThreadEntry } from "@/lib/crm-postgres/bulk-offers";
import type { OfferPosition } from "@/lib/bulk-offer-position";
import { cleanMessage, dayMonth } from "@/lib/bulk-offer-position-core";
import { shortDate } from "@/lib/bulk-trade-details";
import { DetailSheet, ErrorText, buttonClass, buttonStyle, darkButtonClass, darkButtonStyle, inputClass, inputStyle, request } from "./trade-ui";
import { MailDraftView } from "../crm/inbox/mail-draft-view";
import { rowFocus } from "./demand-page";

import { BusyRegion, Sh } from "./bt-shimmer";

/** An offer as the list reads it: the row plus where it stands, worked out on read from the newest messages. */
type OfferRow = Offer & { chase_due?: boolean; position?: OfferPosition | null };

const PLACEHOLDER_OFFER = { id: "loading", name: null, stage: "candidate", messages: 1 } as OfferRow;
const PLACEHOLDER_OFFERS: OfferRow[] = Array.from({ length: 4 }, (_, i) => ({ ...PLACEHOLDER_OFFER, id: `loading-${i}` }));
const PLACEHOLDER_THREAD = Array.from({ length: 4 }, (_, i) => ({ id: `loading-${i}`, channel: "note", title: "", body: " ", at: "", direction: null, ref: null, href: null } as ThreadEntry));

const STAGES: [OfferStage, string][] = [
  ["candidate", "Candidate"], ["offered", "Offered"], ["negotiating", "Negotiating"],
  ["contract_out", "Contract out"], ["signed", "Signed"], ["invoiced", "Invoice out"], ["paid", "Paid"], ["complete", "Complete"],
  ["declined", "Declined"], ["lost", "Lost"],
];
const STAGE_LABEL = Object.fromEntries(STAGES) as Record<OfferStage, string>;
const GREEN = { fg: "var(--bt-green)", bg: "var(--bt-green-bg)", border: "var(--bt-green-border)" };
const RED = { fg: "var(--bt-red)", bg: "var(--bt-red-bg)", border: "var(--bt-red-border)" };
const AMBER = { fg: "var(--bt-amber)", bg: "var(--bt-amber-bg)", border: "var(--bt-amber-border)" };
const GREY = { fg: "var(--bt-text-2)", bg: "var(--bt-segment)", border: "var(--bt-border)" };
/** Stage badge colours: a dot and a tinted pill per stage, so the pipeline reads at a glance. */
const STAGE_TONE: Record<OfferStage, { fg: string; bg: string; border: string }> = {
  candidate: { fg: "var(--bt-muted)", bg: "var(--bt-segment)", border: "var(--bt-border)" },
  offered: { fg: "var(--bt-blue)", bg: "var(--bt-blue-bg)", border: "var(--bt-blue-border)" },
  negotiating: { fg: "var(--bt-blue)", bg: "var(--bt-blue-bg)", border: "var(--bt-blue-border)" },
  contract_out: AMBER, signed: AMBER, invoiced: AMBER,
  paid: GREEN, complete: GREEN, declined: RED, lost: RED,
};
const CHANNEL_ICON = { mail: Mail, whatsapp: MessageCircle, call: Phone, note: StickyNote, quote: Tag, status: Tag, document: FileText, other: StickyNote } as const;
/** Someone kept waiting this long is late. */
const LATE_DAYS = 7;

const initials = (name: string | null) => (name ?? "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("") || "?";
const dateOf = (iso: string | null) => (iso ? shortDate(iso.slice(0, 10)) : "");
const daysText = (n: number) => (n === 0 ? "today" : n === 1 ? "1 day" : `${n} days`);

function StagePill({ stage, loading = false }: { stage: OfferStage | null; loading?: boolean }) {
  const tone = stage ? STAGE_TONE[stage] : null;
  return (
    <span data-stage={stage ?? undefined} className="inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium"
      style={tone ? { background: tone.bg, color: tone.fg, borderColor: tone.border } : { background: "var(--bt-segment)", color: "var(--bt-muted)", borderColor: "var(--bt-border)" }}>
      {!loading && <span className="h-1.5 w-1.5 rounded-full" style={{ background: tone?.fg ?? "var(--bt-muted)" }} aria-hidden />}
      <Sh on={loading} chars={7}>{stage ? STAGE_LABEL[stage] : ""}</Sh>
    </span>
  );
}

function Avatar({ name, size = 32, loading = false }: { name: string | null; size?: number; loading?: boolean }) {
  return (
    <span className="flex shrink-0 items-center justify-center rounded-full text-[12px] font-semibold" aria-hidden
      style={{ width: size, height: size, background: "var(--bt-segment)", color: "var(--bt-text-2)" }}><Sh on={loading} chars={2}>{initials(name)}</Sh></span>
  );
}

const Pill = ({ tone, children, ...rest }: { tone: { fg: string; bg: string; border: string }; children: ReactNode } & Record<`data-${string}`, string>) => (
  <span {...rest} className="inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold" style={{ background: tone.bg, color: tone.fg, borderColor: tone.border }}>{children}</span>
);

/** Whose move it is, and for how long: ours turns red once someone has waited a week. */
function TurnPill({ position }: { position: OfferPosition }) {
  if (position.turn === "closed") return null;
  const us = position.turn === "us";
  const label = `${us ? "Your move" : "Their move"}${position.since ? ` · ${daysText(position.days)}` : ""}`;
  return <Pill data-turn={position.turn} tone={us ? (position.days >= LATE_DAYS ? RED : AMBER) : GREY}>{label}</Pill>;
}

/** The price on the table: what they ask, what we bid, how far apart. */
function PriceLine({ position }: { position: OfferPosition }) {
  if (!position.price) return <span className="text-[12px]" style={{ color: "var(--bt-muted)" }}>No price yet</span>;
  return (
    <span className="flex flex-wrap items-center gap-1.5 text-[12px]">
      {position.price.parts.map((part, k) => (
        <span key={part.label} className="contents">
          {k > 0 && <span aria-hidden style={{ color: "var(--bt-muted)" }}>→</span>}
          <span className="rounded-md px-2 py-0.5" style={part.kind === "none" ? { border: "1px dashed var(--bt-dashed)" } : { background: "var(--bt-segment)" }}>
            <span style={{ color: "var(--bt-muted)" }}>{part.label} </span><span className="font-semibold">{part.value}</span>
            {part.note && <span style={{ color: "var(--bt-muted)" }}> · {part.note}</span>}
          </span>
        </span>
      ))}
      {position.price.gap && <span className="rounded-md px-2 py-0.5 font-semibold" style={{ background: "var(--bt-amber-bg)", color: "var(--bt-amber)" }}>{position.price.gap}</span>}
    </span>
  );
}

/** How far it has got: one small step per stage, done, now or still to come. */
function Steps({ position }: { position: OfferPosition }) {
  return (
    <ol className="flex flex-wrap gap-1" aria-label="How far it has got">
      {position.steps.map((s) => (
        <li key={s.label} data-step={s.state} className="rounded-full border px-1.5 py-px text-[10.5px]"
          style={s.state === "done" ? { background: "var(--bt-green-bg)", color: "var(--bt-green)", borderColor: "var(--bt-green-border)" }
            : s.state === "now" ? { color: "var(--bt-amber)", borderColor: "var(--bt-amber)", fontWeight: 600 }
            : { color: "var(--bt-muted)", borderColor: "var(--bt-border)" }}>
          {s.state === "done" ? "✓ " : ""}{s.label}
        </li>
      ))}
    </ol>
  );
}

/** A stage the newest messages point to, for a person to confirm: Move it, or Not yet (remembered for that message). */
function StageHintBar({ offer, onPatch }: { offer: OfferRow; onPatch: (body: Record<string, unknown>) => Promise<void> }) {
  const hint = offer.position?.hint;
  const [busy, setBusy] = useState(false);
  if (!hint) return null;
  const from = hint.stage === "paid" ? "Their message" : hint.stage === "invoiced" ? "Your email" : "A message";
  const act = async (body: Record<string, unknown>) => { setBusy(true); try { await onPatch(body); } finally { setBusy(false); } };
  return (
    <div data-stage-hint className="mx-4 mb-3 flex flex-wrap sm:ml-[60px] items-center gap-2 border px-3 py-2 text-[12px]" style={{ background: "var(--bt-blue-bg)", borderColor: "var(--bt-blue-border)" }}>
      <span className="min-w-0 flex-1">{from} on {dayMonth(hint.at)}: &ldquo;{hint.quote}&rdquo; Move the stage from <b>{offer.stage ? STAGE_LABEL[offer.stage] : "Candidate"}</b> to <b>{STAGE_LABEL[hint.stage]}</b>?</span>
      <button type="button" disabled={busy} className={`${rowFocus} ${darkButtonClass} h-8`} style={darkButtonStyle} onClick={() => void act({ stage: hint.stage })}>Move it</button>
      <button type="button" disabled={busy} className={`${rowFocus} ${buttonClass} h-8`} style={buttonStyle} onClick={() => void act({ stageHintSkip: hint.messageId })}>Not yet</button>
    </div>
  );
}

const sinceOf = (o: OfferRow) => (o.position?.since ? Date.parse(o.position.since) : Number.POSITIVE_INFINITY);
/** Your move first, longest wait first; then their move, chases first; closed ones last and folded. */
function groupOffers(offers: OfferRow[]) {
  const turn = (o: OfferRow) => o.position?.turn ?? (o.stage === "complete" || o.stage === "declined" || o.stage === "lost" ? "closed" : "us");
  const us = offers.filter((o) => turn(o) === "us").sort((a, b) => sinceOf(a) - sinceOf(b));
  const them = offers.filter((o) => turn(o) === "them").sort((a, b) => Number(!!b.position?.chase) - Number(!!a.position?.chase) || sinceOf(a) - sinceOf(b));
  const closed = offers.filter((o) => turn(o) === "closed");
  return { us, them, closed };
}

/** Who we offered this to, one thread each, sorted by whose move it is. Inside a thread: how the price moved, the messages, and the controls. */
export function OffersTab({ demandId, listingId, request: requestSide = false, onChanged }: { demandId: string; listingId?: string; request?: boolean; onChanged: () => void }) {
  const base = listingId ? `/api/bulk-listings/${encodeURIComponent(listingId)}/offers` : `/api/bulk-trades/demand/${encodeURIComponent(demandId)}/offers`;
  const [offers, setOffers] = useState<OfferRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setOffers((await request<{ offers: OfferRow[] }>(base)).offers); setError(null); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not load offers."); }
  }, [base]);
  useEffect(() => { void load(); }, [load]);
  return <OfferList offers={offers} error={error} base={base} request={requestSide} onUpdated={() => { void load(); onChanged(); }} />;
}

function OfferList({ offers, error, base, request: requestSide, onUpdated }: {
  offers: OfferRow[] | null; error: string | null; base: string; request: boolean; onUpdated: () => void;
}) {
  // The open email draft, shown in the side panel over the list.
  const [draft, setDraft] = useState<{ offerId: string; draftId: string } | null>(null);
  // A send moves the stage, so the open thread is rebuilt from fresh data once the mail is gone.
  const [sentCount, setSentCount] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const loading = offers === null && !error;
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  async function create(input: { name: string; contact?: string }) {
    setBusy(true); setFormError(null);
    try { const created = (await request<{ offer: Offer }>(base, { method: "POST", body: JSON.stringify({ ...input, source: "manual" }) })).offer; onUpdated(); setOpenId(created.id); setName(""); setContact(""); setAdding(false); }
    catch (err) { setFormError(err instanceof Error ? err.message : "Could not add."); }
    finally { setBusy(false); }
  }
  /** A change made from a row itself (a stage suggestion), outside the open thread. */
  const patchRow = (offerId: string) => async (body: Record<string, unknown>) => {
    setRowError(null);
    try { await request(`${base}/${encodeURIComponent(offerId)}`, { method: "PATCH", body: JSON.stringify(body) }); setSentCount((c) => c + 1); onUpdated(); }
    catch (err) { setRowError(err instanceof Error ? err.message : "Could not save."); }
  };
  const groups = offers ? groupOffers(offers) : null;

  const row = (o: OfferRow) => {
    const p = o.position;
    const isOpen = openId === o.id;
    return (
      <li key={o.id} className="border-t first:border-t-0" style={{ borderColor: "var(--bt-border)" }}>
        <button type="button" disabled={loading} aria-expanded={loading ? undefined : isOpen} onClick={() => setOpenId(isOpen ? null : o.id)} className={`${rowFocus} flex w-full flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3 text-left`}>
          <span className="flex min-w-0 flex-[999_1_420px] gap-3">
            <span className="mt-2 shrink-0" style={{ color: "var(--bt-muted)" }} aria-hidden>{isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
            <Avatar name={o.name} loading={loading} />
            <span className="flex min-w-0 flex-col gap-1">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-[14px] font-semibold"><Sh on={loading} chars={18}>{o.name ?? "Unnamed"}</Sh></span>
                <StagePill stage={o.stage} loading={loading} />
                {!loading && o.incoming && o.from_kind && <span className="text-[11px]" style={{ color: "var(--bt-muted)" }}>From {o.from_kind}: {o.from_label ?? ""}</span>}
                {!loading && o.wants && <span className="min-w-0 truncate text-[12px]" style={{ color: "var(--bt-muted)" }}>{o.wants}</span>}
              </span>
              {!loading && p?.next && <span className="text-[13.5px] font-semibold leading-snug">{p.next}</span>}
              {!loading && o.declined_reason && (o.stage === "declined" || o.stage === "lost") && <span className="text-[12px]" style={{ color: "var(--bt-muted)" }}>Why: {o.declined_reason}</span>}
              {!loading && p && <PriceLine position={p} />}
              {loading && <span className="text-[12px]" style={{ color: "var(--bt-muted)" }}><Sh on chars={32}>{" "}</Sh></span>}
            </span>
          </span>
          {!loading && p && (
            <span className="flex min-w-0 flex-[1_1_240px] flex-col gap-1.5">
              <span className="flex flex-wrap items-center gap-1.5">
                <TurnPill position={p} />
                {p.chase && <Pill data-chase="" tone={AMBER}>Chase today</Pill>}
              </span>
              {p.turn !== "closed" && <span className="text-[12px]" style={{ color: "var(--bt-muted)" }}>{p.reason}</span>}
              {p.turn !== "closed" && <Steps position={p} />}
              <span className="text-[11px]" style={{ color: "var(--bt-muted)" }}>{o.messages > 0 ? `${o.messages} ${o.messages === 1 ? "message" : "messages"}${o.last_message_at ? ` · ${dateOf(o.last_message_at)}` : ""}` : "No messages"}</span>
            </span>
          )}
        </button>
        {!loading && <StageHintBar offer={o} onPatch={patchRow(o.id)} />}
        {!loading && isOpen && <ThreadPanel key={`${o.id}-${sentCount}`} base={base} offerId={o.id} request={requestSide} onUpdated={onUpdated} onDraft={(draftId) => setDraft({ offerId: o.id, draftId })} />}
      </li>
    );
  };
  const section = (title: string, sub: string, list: OfferRow[]) => list.length > 0 && (
    <section aria-label={title} className="flex flex-col gap-2">
      <h4 className="flex flex-wrap items-baseline gap-2 text-[13px] font-semibold">{title} · {list.length} <span className="text-[12px] font-normal" style={{ color: "var(--bt-muted)" }}>{sub}</span></h4>
      <ul className="flex flex-col overflow-hidden border" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)", borderRadius: 10 }}>{list.map(row)}</ul>
    </section>
  );

  return (
    <BusyRegion busy={loading} label="Loading offers" className="flex w-full flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-mono text-[11px] uppercase tracking-[0.06em]" style={{ color: "var(--bt-muted)" }}>Offers · <Sh on={loading} chars={1}>{offers?.length}</Sh></h3>
        <button type="button" className={`${rowFocus} ${buttonClass} inline-flex items-center gap-1.5`} style={buttonStyle} onClick={() => setAdding(!adding)}>
          <Plus size={14} aria-hidden /> New offer
        </button>
      </div>
      {adding && (
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void create({ name, contact: contact || undefined }); }}>
          <input aria-label="Name or company" placeholder="Name or company" value={name} onChange={(e) => setName(e.target.value)} className={`${inputClass} min-w-[180px] flex-1`} style={inputStyle} autoFocus />
          <input aria-label="Email" placeholder="Email (links their messages)" value={contact} onChange={(e) => setContact(e.target.value)} className={`${inputClass} min-w-[200px] flex-1`} style={inputStyle} />
          <button type="submit" disabled={busy || !name.trim()} className={`${rowFocus} ${buttonClass}`} style={buttonStyle}>Start thread</button>
        </form>
      )}
      <ErrorText error={error ?? formError ?? rowError} />
      {loading && <ul className="flex flex-col overflow-hidden border" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)", borderRadius: 10 }}>{PLACEHOLDER_OFFERS.map(row)}</ul>}
      {groups && (
        <>
          {section("Your move", "Longest wait first", groups.us)}
          {section("Their move", "Chases first. A chase is due after 3 working days with no reply.", groups.them)}
          {groups.closed.length > 0 && (
            <section aria-label="Closed" className="flex flex-col gap-2">
              <button type="button" aria-expanded={showClosed} onClick={() => setShowClosed(!showClosed)} className={`${rowFocus} inline-flex items-center gap-1 self-start text-[13px] font-semibold`}>
                {showClosed ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />} Closed · {groups.closed.length}
              </button>
              {showClosed && <ul className="flex flex-col overflow-hidden border" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)", borderRadius: 10 }}>{groups.closed.map(row)}</ul>}
            </section>
          )}
        </>
      )}
      {offers && !offers.length && !adding && (
        <p className="text-[13px]" style={{ color: "var(--bt-muted)" }}>No offers yet. Shortlist on Matches, or start a thread for each person you offer this to.</p>
      )}
      {draft && (
        <DetailSheet title="Email draft" onClose={() => setDraft(null)}>
          <MailDraftView draftId={draft.draftId} sendPath={`${base}/${encodeURIComponent(draft.offerId)}/send`}
            onSent={() => { setSentCount((count) => count + 1); onUpdated(); }} />
        </DetailSheet>
      )}
    </BusyRegion>
  );
}

/** A thread line as the open row shows it: their words without quoted mail, a run of WhatsApps as one bubble. */
type Bubble = { id: string; channel: ThreadEntry["channel"]; direction: ThreadEntry["direction"]; who: string; at: string; title: string | null; text: string; href: string | null; count: number };
const MESSAGES_SHOWN = 6;
const RUN_MS = 30 * 60_000;

function bubbles(entries: ThreadEntry[], name: string | null): Bubble[] {
  const out: Bubble[] = [];
  for (const e of [...entries].filter((x) => x.channel !== "quote" && x.channel !== "status").sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    const who = e.direction === "outbound" ? "You" : e.direction === "inbound" ? (name ?? "Them") : e.channel === "call" ? "Call" : "Note";
    const text = e.channel === "mail" ? cleanMessage(e.body) || (e.body ?? "").trim() : (e.body ?? "").trim();
    const last = out[out.length - 1];
    if (e.channel === "whatsapp" && last?.channel === "whatsapp" && last.direction === e.direction && Date.parse(e.at) - Date.parse(last.at) < RUN_MS) {
      last.text = `${last.text}\n${text}`; last.count += 1; last.at = e.at; continue;
    }
    out.push({ id: e.id, channel: e.channel, direction: e.direction, who, at: e.at, title: e.channel === "mail" || e.channel === "call" || e.channel === "note" || e.channel === "document" || e.channel === "other" ? e.title : null, text, href: e.href, count: 1 });
  }
  return out;
}

function BubbleItem({ b }: { b: Bubble }) {
  const ours = b.direction === "outbound";
  const Icon = CHANNEL_ICON[b.channel];
  const [open, setOpen] = useState(false);
  const long = b.text.length > 420;
  return (
    <li className={`flex ${ours ? "justify-end" : "justify-start"}`}>
      <div className="flex max-w-[88%] flex-col gap-1 rounded-xl border px-3 py-2 text-[12.5px]"
        style={ours ? { background: "var(--bt-blue-bg)", borderColor: "var(--bt-blue-border)" } : { background: "var(--bt-table-head)", borderColor: "var(--bt-divider)" }}>
        <span className="flex flex-wrap items-center gap-x-1.5 text-[11.5px]" style={{ color: "var(--bt-muted)" }}>
          <Icon size={12} aria-label={b.channel === "mail" ? "Email" : b.channel === "whatsapp" ? "WhatsApp" : b.channel} />
          <b className="font-semibold" style={{ color: "var(--bt-text)" }}>{b.who}</b>
          <span>· {dateOf(b.at)}{b.count > 1 ? ` · ${b.count} messages` : ""}</span>
          {b.title && b.channel !== "note" && <span className="min-w-0 truncate">· {b.title}</span>}
        </span>
        {b.channel === "note" || b.channel === "call" || b.channel === "document" || b.channel === "other" ? <span>{b.title}{b.text ? ` · ${b.text}` : ""}</span> : null}
        {(b.channel === "mail" || b.channel === "whatsapp") && b.text && <span className="whitespace-pre-wrap" style={{ overflowWrap: "anywhere" }}>{long && !open ? `${b.text.slice(0, 420).replace(/\s+\S*$/, "")}…` : b.text}</span>}
        <span className="flex flex-wrap gap-3">
          {long && <button type="button" className={`${rowFocus} text-[11.5px] font-semibold`} style={{ color: "var(--bt-link)" }} onClick={() => setOpen(!open)}>{open ? "Show less" : "Show all"}</button>}
          {b.href && (
            <a href={b.href} target={b.href.startsWith("http") ? "_blank" : undefined} rel="noreferrer" className={`${rowFocus} inline-flex items-center gap-1 text-[11.5px] font-semibold`} style={{ color: "var(--bt-link)" }}>
              <ExternalLink size={11} aria-hidden /> {b.channel === "mail" ? "Open email" : b.channel === "call" ? "Open call notes" : "Open source"}
            </a>
          )}
        </span>
      </div>
    </li>
  );
}

/** The open thread inside its offer row: how the price moved, the messages newest last, then the controls. */
function ThreadPanel({ base, offerId, request: requestSide, onUpdated, onDraft }: {
  base: string; offerId: string; request: boolean; onUpdated: () => void; onDraft: (draftId: string) => void;
}) {
  const url = `${base}/${encodeURIComponent(offerId)}`;
  const [drafting, setDrafting] = useState(false);
  const [offer, setOffer] = useState<OfferRow | null>(null);
  const [thread, setThread] = useState<ThreadEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [all, setAll] = useState(false);
  /** A lost or declined stage waits here until its reason is written. */
  const [outcomeStage, setOutcomeStage] = useState<"declined" | "lost" | null>(null);
  const [outcomeReason, setOutcomeReason] = useState("");
  /** What the outcome did to the linked stock, or the suggestion when there is no stock link. */
  const [outcomeNote, setOutcomeNote] = useState<string | null>(null);
  const apply = (r: { offer: OfferRow; thread?: ThreadEntry[] }) => {
    setOffer(r.offer); if (r.thread) setThread(r.thread);
  };
  useEffect(() => { let live = true; request<{ offer: OfferRow; thread: ThreadEntry[] }>(url).then((r) => { if (live) apply(r); }).catch((e) => { if (live) setError(e instanceof Error ? e.message : "Could not load."); }); return () => { live = false; }; }, [url]);
  async function patch(body: Record<string, unknown>) {
    setBusy(true); setError(null);
    try {
      const r = await request<{ offer: OfferRow; noStock?: { marked: string | null; suggestion: string | null } }>(url, { method: "PATCH", body: JSON.stringify(body) });
      setOffer(r.offer);
      setOutcomeNote(r.noStock?.marked ? "The linked stock line is now stale." : r.noStock?.suggestion ?? null);
      const t = await request<{ offer: OfferRow; thread: ThreadEntry[] }>(url); apply(t); onUpdated();
    }
    catch (err) { setError(err instanceof Error ? err.message : "Could not save."); } finally { setBusy(false); }
  }
  /** Builds or reopens the offer email, then shows it in the side panel to edit and send. */
  async function draftEmail() {
    setDrafting(true); setError(null);
    try { const r = await request<{ draftId: string }>(`${url}/draft`, { method: "POST" }); onDraft(r.draftId); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not draft the email."); }
    finally { setDrafting(false); }
  }
  const loading = offer === null && !error;
  const current = offer ?? PLACEHOLDER_OFFER;
  const p = offer?.position ?? null;
  const shown = loading ? [] : bubbles(thread, current.name);
  const visible = all ? shown : shown.slice(-MESSAGES_SHOWN);
  // Price moves: the dated ones the terms hold, and every price change logged since.
  const moves = [
    ...(p?.moves ?? []).map((m) => ({ ...m, key: `t${m.at}${m.text}` })),
    // A logged change is titled "<name> · price updated": the name is already on the row.
    ...thread.filter((e) => e.channel === "quote").map((e) => { const title = e.title.replace(/^.*? · /, "").replace(/^./, (c) => c.toUpperCase()); return { at: e.at, who: "", text: e.body ? `${title}: ${e.body}` : `${title}.`, key: e.id }; }),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const newestMail = [...thread].filter((e) => e.channel === "mail" && e.href).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
  const turnSet = !!offer?.waiting_set_at && p?.source === "manual";
  return (
    <BusyRegion busy={loading} label="Loading thread" className="flex w-full flex-col gap-4 pb-4 pl-4 pr-4 sm:pl-[60px]">
      <div className="flex flex-wrap gap-x-7 gap-y-4 border-t pt-3" style={{ borderColor: "var(--bt-divider)", borderTopStyle: "dashed" }}>
        <section aria-label="How the price moved" className="flex min-w-0 flex-[1_1_260px] flex-col gap-2">
          <h4 className="font-mono text-[10.5px] uppercase tracking-[0.06em]" style={{ color: "var(--bt-muted)" }}>How the price moved</h4>
          {loading ? <Sh on chars={30}>{" "}</Sh> : moves.length ? (
            <ul className="flex flex-col gap-1.5 text-[12.5px]">
              {moves.map((m) => <li key={m.key} className="grid grid-cols-[52px_minmax(0,1fr)] gap-2"><span style={{ color: "var(--bt-muted)" }}>{dayMonth(m.at)}</span><span>{m.who && <b className="font-semibold">{m.who} </b>}{m.text}</span></li>)}
            </ul>
          ) : <p className="text-[12.5px]" style={{ color: "var(--bt-muted)" }}>No price on record yet.</p>}
        </section>
        <section aria-label="Thread" className="flex min-w-0 flex-[999_1_380px] flex-col gap-2">
          <h4 className="font-mono text-[10.5px] uppercase tracking-[0.06em]" style={{ color: "var(--bt-muted)" }}>Messages, newest last</h4>
          {offer && shown.length === 0 && <p className="text-[13px]" style={{ color: "var(--bt-muted)" }}>Nothing yet. Email and WhatsApp with this person appear here once they are linked to a CRM person or email.</p>}
          {loading && <ul>{PLACEHOLDER_THREAD.map((e) => <MessageItem key={e.id} entry={e} loading />)}</ul>}
          {!all && shown.length > MESSAGES_SHOWN && <button type="button" className={`${rowFocus} self-start text-[12px] font-semibold`} style={{ color: "var(--bt-link)" }} onClick={() => setAll(true)}>Show all {shown.length}</button>}
          <ul className="flex flex-col gap-2">{visible.map((b) => <BubbleItem key={b.id} b={b} />)}</ul>
        </section>
      </div>
      <ErrorText error={error} />
      <div className="flex flex-wrap items-center gap-2 border-t pt-3" style={{ borderColor: "var(--bt-divider)" }}>
        {newestMail?.href && <a href={newestMail.href} className={`${rowFocus} ${darkButtonClass} gap-1.5`} style={darkButtonStyle}><Mail size={13} aria-hidden /> Open the email</a>}
        {offer && (offer.stage === "candidate" || offer.stage === "offered") && (
          <button type="button" disabled={busy || drafting} onClick={() => void draftEmail()} className={`${rowFocus} ${buttonClass} inline-flex items-center gap-1.5`} style={buttonStyle}>
            <Mail size={13} aria-hidden /> {drafting ? "Preparing…" : "Draft email"}
          </button>
        )}
        {p?.chase && <button type="button" disabled={busy} className={`${rowFocus} ${buttonClass}`} style={buttonStyle} onClick={() => void patch({ chaseOff: true })}>Don&apos;t chase</button>}
        <label className="flex items-center gap-1.5 text-[12px]" style={{ color: "var(--bt-muted)" }}>
          Whose move
          <select aria-label="Whose move" value={turnSet ? offer?.waiting_on ?? "" : ""} disabled={busy || !offer}
            onChange={(e) => void patch({ turn: e.target.value || null })}
            className="border px-2 py-1 text-[12px]" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)", color: "var(--bt-text)" }}>
            <option value="">Read from messages</option>
            <option value="us">Your move</option>
            <option value="them">Their move</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-[12px]" style={{ color: "var(--bt-muted)" }}>
          Stage
          <select aria-label="Stage" value={outcomeStage ?? current.stage ?? "candidate"} disabled={busy || !offer}
            onChange={(e) => {
              const next = e.target.value as OfferStage;
              if (!offer) { return; }
              // Lost and declined need a reason first, so the stage only saves once it is written.
              if (next === "declined" || next === "lost") { setOutcomeStage(next); setOutcomeReason(offer.declined_reason ?? ""); return; }
              setOutcomeStage(null); void patch({ stage: next });
            }}
            className="border px-2 py-1 text-[12px]" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)", color: "var(--bt-text)" }}>
            {STAGES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <span className="min-w-0 flex-1 truncate text-right text-[12px]" style={{ color: "var(--bt-muted)" }}><Sh on={loading} chars={30}>{current.contact || ""}</Sh></span>
      </div>
      {outcomeStage && (
        <form aria-label={`Reason for ${STAGE_LABEL[outcomeStage].toLowerCase()}`} className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const reason = outcomeReason.trim();
            if (!reason) { return; }
            const stage = outcomeStage;
            setOutcomeStage(null);
            void patch({ stage, declinedReason: reason });
          }}>
          <span className="text-[12px]" style={{ color: "var(--bt-muted)" }}>{STAGE_LABEL[outcomeStage]}: why?</span>
          {requestSide && (
            <span className="flex flex-wrap items-center gap-1.5">
              {["No stock", "Price", "Wrong spec", "Went elsewhere"].map((reason) => (
                <button key={reason} type="button" disabled={busy} onClick={() => setOutcomeReason(reason)}
                  className={`${rowFocus} rounded-full border px-2 py-0.5 text-[11px]`} style={buttonStyle}>{reason}</button>
              ))}
            </span>
          )}
          <input aria-label="Outcome reason" required maxLength={500} autoFocus value={outcomeReason} onChange={(e) => setOutcomeReason(e.target.value)}
            placeholder="Why it ended, e.g. price too high, chose another supplier"
            className={`${inputClass} min-w-[240px] flex-1 text-[12px]`} style={inputStyle} />
          <button type="submit" disabled={busy || !outcomeReason.trim()} className={`${rowFocus} ${buttonClass}`} style={buttonStyle}>Save outcome</button>
          <button type="button" disabled={busy} className={`${rowFocus} ${buttonClass}`} style={buttonStyle} onClick={() => setOutcomeStage(null)}>Cancel</button>
        </form>
      )}
      {outcomeNote && <p role="status" className="text-[12px]" style={{ color: "var(--bt-muted)" }}>{outcomeNote}</p>}
      {offer && !offer.incoming && offer.link_options.length > 0 && (
        <label className="flex items-center gap-2 text-[12px]" style={{ color: "var(--bt-muted)" }}>
          Not linked.
          <select aria-label="Link to listing" value="" disabled={busy}
            onChange={(e) => e.target.value && void patch({ counterpartId: e.target.value })}
            className="border px-2 py-1 text-[12px]" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
            <option value="">Link to a live listing…</option>
            {offer.link_options.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select>
        </label>
      )}
    </BusyRegion>
  );
}

/** One message in a thread. Collapsed it is a line (channel, title, date); open it shows the whole message. */
export function MessageItem({ entry: e, loading }: { entry: ThreadEntry; loading: boolean }) {
  const [open, setOpen] = useState(false);
  const Icon = CHANNEL_ICON[e.channel];
  const Dir = e.direction === "inbound" ? ArrowDownLeft : e.direction === "outbound" ? ArrowUpRight : null;
  const expandable = !loading && !!e.body;
  const head = (
    <>
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full" style={{ background: "var(--bt-segment)", color: "var(--bt-muted)" }}><Icon size={13} aria-hidden /></span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-[13px] font-semibold"><Sh on={loading} chars={24}>{e.title}</Sh></span>
          {Dir && <Dir size={12} aria-label={e.direction ?? ""} style={{ color: "var(--bt-muted)" }} />}
          <time className="ml-auto shrink-0 text-[11px] font-bold" style={{ color: "var(--bt-text-2)" }} dateTime={e.at}><Sh on={loading} chars={7}>{dateOf(e.at)}</Sh></time>
          {expandable && <span className="shrink-0" style={{ color: "var(--bt-muted)" }} aria-hidden>{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>}
        </span>
        {e.body && (
          <span className={`mt-0.5 block whitespace-pre-wrap text-[12px] ${open ? "" : "line-clamp-1"}`} style={{ color: "var(--bt-muted)" }}><Sh on={loading} chars={36}>{e.body}</Sh></span>
        )}
      </span>
    </>
  );
  return (
    <li className="border-t first:border-t-0" style={{ borderColor: "var(--bt-divider)" }}>
      {expandable
        ? <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className={`${rowFocus} flex w-full gap-3 py-3 text-left`}>{head}</button>
        : <div className="flex gap-3 py-3">{head}</div>}
      {!loading && e.href && (
        <a href={e.href} target={e.href.startsWith("http") ? "_blank" : undefined} rel="noreferrer"
          className={`${rowFocus} mb-3 ml-10 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]`} style={{ background: "var(--bt-segment)", color: "var(--bt-text-2)" }}>
          <ExternalLink size={11} aria-hidden /> {e.channel === "mail" ? "Open email" : e.channel === "call" ? "Open call notes" : "Open source"}
        </a>
      )}
    </li>
  );
}
