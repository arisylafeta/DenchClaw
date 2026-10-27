"use client";

import { ChevronDown, ChevronRight, ExternalLink, Mail, MessageCircle, Phone, Plus, StickyNote, Tag, ArrowDownLeft, ArrowUpRight } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { Offer, OfferStage, ThreadEntry } from "@/lib/crm-postgres/bulk-offers";
import { shortDate } from "@/lib/bulk-trade-details";
import { ErrorText, buttonClass, buttonStyle, inputClass, inputStyle, request } from "./trade-ui";
import { rowFocus } from "./demand-page";

import { BusyRegion, Sh } from "./bt-shimmer";

const PLACEHOLDER_OFFER = { id: "loading", name: null, stage: "candidate", messages: 1 } as Offer;
const PLACEHOLDER_OFFERS = Array.from({ length: 4 }, (_, i) => ({ ...PLACEHOLDER_OFFER, id: `loading-${i}` }));
const PLACEHOLDER_THREAD = Array.from({ length: 4 }, (_, i) => ({ id: `loading-${i}`, channel: "note", title: "", body: " ", at: "", direction: null, ref: null, href: null } as ThreadEntry));

const STAGES: [OfferStage, string][] = [
  ["candidate", "Candidate"], ["offered", "Offered"], ["negotiating", "Negotiating"],
  ["contract_out", "Contract out"], ["signed", "Signed"], ["invoiced", "Invoice out"], ["paid", "Paid"], ["complete", "Complete"],
  ["declined", "Declined"], ["lost", "Lost"],
];
const STAGE_LABEL = Object.fromEntries(STAGES) as Record<OfferStage, string>;
const GREEN = { fg: "var(--bt-green)", bg: "var(--bt-green-bg)", border: "var(--bt-green-border)" };
const RED = { fg: "var(--bt-red)", bg: "var(--bt-red-bg)", border: "var(--bt-red-border)" };
/** Stage badge colours: a dot and a tinted pill per stage, so the pipeline reads at a glance. */
const STAGE_TONE: Record<OfferStage, { fg: string; bg: string; border: string }> = {
  candidate: { fg: "var(--bt-muted)", bg: "var(--bt-segment)", border: "var(--bt-border)" },
  offered: { fg: "var(--bt-blue)", bg: "var(--bt-blue-bg)", border: "var(--bt-blue-border)" },
  negotiating: { fg: "var(--bt-blue)", bg: "var(--bt-blue-bg)", border: "var(--bt-blue-border)" },
  contract_out: { fg: "var(--bt-amber)", bg: "var(--bt-amber-bg)", border: "var(--bt-amber-border)" },
  signed: { fg: "var(--bt-amber)", bg: "var(--bt-amber-bg)", border: "var(--bt-amber-border)" },
  invoiced: { fg: "var(--bt-amber)", bg: "var(--bt-amber-bg)", border: "var(--bt-amber-border)" },
  paid: GREEN, complete: GREEN, declined: RED, lost: RED,
};
const CHANNEL_ICON = { mail: Mail, whatsapp: MessageCircle, call: Phone, note: StickyNote, quote: Tag, status: Tag, document: Tag, other: StickyNote } as const;

const initials = (name: string | null) => (name ?? "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("") || "?";
const dateOf = (iso: string | null) => (iso ? shortDate(iso.slice(0, 10)) : "");
const termsLine = (o: Offer) => {
  const t = o.terms;
  if (t?.amount == null) return null;
  return `${t.amount.toLocaleString("en-GB")} ${t.currency ?? ""}${t.unit ? `/${t.unit}` : ""}${t.firmness ? ` · ${t.firmness}` : ""}`.trim();
};

function StagePill({ stage, loading = false }: { stage: OfferStage | null; loading?: boolean }) {
  if (!stage) return null;
  const tone = STAGE_TONE[stage];
  return (
    <span data-stage={stage} className="inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium" style={{ background: tone.bg, color: tone.fg, borderColor: tone.border }}>
      {!loading && <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: tone.fg }} />}
      <Sh on={loading} chars={7}>{STAGE_LABEL[stage]}</Sh>
    </span>
  );
}

function Avatar({ name, size = 32, loading = false }: { name: string | null; size?: number; loading?: boolean }) {
  return (
    <span className="flex shrink-0 items-center justify-center rounded-full text-[12px] font-semibold" aria-hidden
      style={{ width: size, height: size, background: "var(--bt-segment)", color: "var(--bt-text-2)" }}><Sh on={loading} chars={2}>{initials(name)}</Sh></span>
  );
}

/** Whose move it is on this offer: us, or them (with the date it started). Blank when not yet judged. */
function WaitingPill({ offer }: { offer: Offer }) {
  if (!offer.waiting_on) return null;
  const them = offer.waiting_on === "them";
  const since = offer.waiting_since ? ` since ${dateOf(offer.waiting_since)}` : "";
  return (
    <span data-waiting-on={offer.waiting_on} className="inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium"
      style={{ background: "transparent", color: them ? "var(--bt-muted)" : "var(--bt-amber)", borderColor: them ? "var(--bt-border)" : "var(--bt-amber-border)" }}>
      {them ? "Waiting on them" : "On us"}{since}
    </span>
  );
}

/** Who we offered this to, one thread each. Inside a thread: the whole conversation, stage, terms and next step. */
export function OffersTab({ demandId, listingId, onChanged }: { demandId: string; listingId?: string; onChanged: () => void }) {
  const base = listingId ? `/api/bulk-listings/${encodeURIComponent(listingId)}/offers` : `/api/bulk-trades/demand/${encodeURIComponent(demandId)}/offers`;
  const [offers, setOffers] = useState<Offer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setOffers((await request<{ offers: Offer[] }>(base)).offers); setError(null); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not load offers."); }
  }, [base]);
  useEffect(() => { void load(); }, [load]);
  return <OfferList offers={offers} error={error} base={base} onUpdated={() => { void load(); onChanged(); }} />;
}

function OfferList({ offers, error, base, onUpdated }: {
  offers: Offer[] | null; error: string | null; base: string; onUpdated: () => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const loading = offers === null && !error;
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  async function create(input: { name: string; contact?: string }) {
    setBusy(true); setFormError(null);
    try { const created = (await request<{ offer: Offer }>(base, { method: "POST", body: JSON.stringify(input) })).offer; onUpdated(); setOpenId(created.id); setName(""); setContact(""); setAdding(false); }
    catch (err) { setFormError(err instanceof Error ? err.message : "Could not add."); }
    finally { setBusy(false); }
  }
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
      <ErrorText error={error ?? formError} />
      {(loading || (offers && offers.length > 0)) && (
        <ul className="flex flex-col overflow-hidden border" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)", borderRadius: 10 }}>
          {(loading ? PLACEHOLDER_OFFERS : offers ?? []).map((o) => {
            const terms = termsLine(o);
            return (
              <li key={o.id} className="border-t first:border-t-0" style={{ borderColor: "var(--bt-border)" }}>
                <button type="button" disabled={loading} aria-expanded={loading ? undefined : openId === o.id} onClick={() => setOpenId(openId === o.id ? null : o.id)} className={`${rowFocus} flex w-full items-center gap-3 px-4 py-3 text-left`}>
                  <span className="shrink-0" style={{ color: "var(--bt-muted)" }} aria-hidden>{openId === o.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
                  <Avatar name={o.name} loading={loading} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-[14px] font-semibold"><Sh on={loading} chars={18}>{o.name ?? "Unnamed"}</Sh></span>
                      <StagePill stage={o.stage} loading={loading} />
                      {!loading && <WaitingPill offer={o} />}
                    </span>
                    <span className="mt-0.5 block truncate text-[12px]" style={{ color: "var(--bt-muted)" }}>
                      <Sh on={loading} chars={32}>{[o.incoming && o.from_kind ? `From ${o.from_kind}: ${o.from_label ?? ""}` : null, terms, o.next_step ? `Next: ${o.next_step}` : null, o.last_touch_on ? `Last touch ${dateOf(o.last_touch_on)}${o.last_touch_via ? ` by ${o.last_touch_via}` : ""}` : null].filter(Boolean).join(" · ") || "No contact yet"}</Sh>
                    </span>
                  </span>
                  <span className="shrink-0 text-[11px]" style={{ color: "var(--bt-muted)" }}><Sh on={loading} chars={2}>{o.messages > 0 ? `${o.messages} ${o.messages === 1 ? "message" : "messages"}${o.last_message_at ? ` · ${dateOf(o.last_message_at)}` : ""}` : "No messages"}</Sh></span>
                </button>
                {!loading && openId === o.id && <ThreadPanel base={base} offerId={o.id} onUpdated={onUpdated} />}
              </li>
            );
          })}
        </ul>
      )}
      {offers && !offers.length && !adding && (
        <p className="text-[13px]" style={{ color: "var(--bt-muted)" }}>No offers yet. Shortlist on Matches, or start a thread for each person you offer this to.</p>
      )}
    </BusyRegion>
  );
}

/** The open thread inside its offer row: stage, terms, next step, a composer and the messages, each an accordion item. */
function ThreadPanel({ base, offerId, onUpdated }: { base: string; offerId: string; onUpdated: () => void }) {
  const url = `${base}/${encodeURIComponent(offerId)}`;
  const [offer, setOffer] = useState<Offer | null>(null);
  const [thread, setThread] = useState<ThreadEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const apply = (r: { offer: Offer; thread?: ThreadEntry[] }) => {
    setOffer(r.offer); if (r.thread) setThread(r.thread);
  };
  useEffect(() => { let live = true; request<{ offer: Offer; thread: ThreadEntry[] }>(url).then((r) => { if (live) apply(r); }).catch((e) => { if (live) setError(e instanceof Error ? e.message : "Could not load."); }); return () => { live = false; }; }, [url]);
  async function patch(body: Record<string, unknown>) {
    setBusy(true); setError(null);
    try { const r = await request<{ offer: Offer }>(url, { method: "PATCH", body: JSON.stringify(body) }); setOffer(r.offer); const t = await request<{ offer: Offer; thread: ThreadEntry[] }>(url); apply(t); onUpdated(); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not save."); } finally { setBusy(false); }
  }
  const loading = offer === null && !error;
  const current = offer ?? PLACEHOLDER_OFFER;
  const terms = termsLine(current);
  return (
    <BusyRegion busy={loading} label="Loading thread" className="flex w-full flex-col gap-4 pb-4 pl-12 pr-4">
      <div className="flex items-center gap-3">
        <p className="min-w-0 flex-1 truncate text-[12px]" style={{ color: "var(--bt-muted)" }}><Sh on={loading} chars={30}>{[current.contact, current.wants].filter(Boolean).join(" · ") || "No contact details yet"}</Sh></p>
        <select aria-label="Stage" value={current.stage ?? "candidate"} disabled={busy || !offer} onChange={(e) => void patch({ stage: e.target.value })}
          className="border px-2 py-1 text-[12px]" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
          {STAGES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </div>
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
      {terms && <p className="text-[13px]"><span style={{ color: "var(--bt-muted)" }}>Latest terms </span><strong>{terms}</strong></p>}
      <ErrorText error={error} />
      <section aria-label="Thread">
        {offer && thread.length === 0 && <p className="text-[13px]" style={{ color: "var(--bt-muted)" }}>Nothing yet. Email and WhatsApp with this person appear here once they are linked to a CRM person or email.</p>}
        <ul>
          {(loading ? PLACEHOLDER_THREAD : thread).map((e) => <MessageItem key={e.id} entry={e} loading={loading} />)}
        </ul>
      </section>
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
