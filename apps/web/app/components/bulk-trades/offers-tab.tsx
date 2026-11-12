"use client";

import { ChevronDown, ChevronRight, ExternalLink, Mail, MessageCircle, Phone, Plus, StickyNote, Tag, ArrowDownLeft, ArrowUpRight } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { Offer, OfferStage, ThreadEntry } from "@/lib/crm-postgres/bulk-offers";
import { shortDate } from "@/lib/bulk-trade-details";
import { PAID_CURRENCIES, PAID_FACT_LABEL, isPaidStage, missingPaidFacts } from "@/lib/bulk-offer-paid";
import { DetailSheet, ErrorText, buttonClass, buttonStyle, inputClass, inputStyle, request } from "./trade-ui";
import { MailDraftView } from "../crm/inbox/mail-draft-view";
import { rowFocus } from "./demand-page";

import { BusyRegion, Sh } from "./bt-shimmer";

/** An offer as the list reads it: the row plus the chase the server works out on read. */
type OfferRow = Offer & { chase_due?: boolean };

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

/** The offer row's stage and, while it waits, a chase: one unanswered email and three working days. */
function ChasePill() {
  return (
    <span data-chase className="inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium"
      style={{ background: "var(--bt-amber-bg)", color: "var(--bt-amber)", borderColor: "var(--bt-amber-border)" }}>
      Chase
    </span>
  );
}

/** Who we offered this to, one thread each. Inside a thread: the whole conversation, stage, terms and next step. */
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
  const loading = offers === null && !error;
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  async function create(input: { name: string; contact?: string }) {
    setBusy(true); setFormError(null);
    try { const created = (await request<{ offer: Offer }>(base, { method: "POST", body: JSON.stringify({ ...input, source: "manual" }) })).offer; onUpdated(); setOpenId(created.id); setName(""); setContact(""); setAdding(false); }
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
                      {!loading && o.chase_due && <ChasePill />}
                    </span>
                    <span className="mt-0.5 block truncate text-[12px]" style={{ color: "var(--bt-muted)" }}>
                      <Sh on={loading} chars={32}>{[o.chase_due ? "Chase due" : null, o.incoming && o.from_kind ? `From ${o.from_kind}: ${o.from_label ?? ""}` : null, terms, o.declined_reason && (o.stage === "declined" || o.stage === "lost") ? `Why: ${o.declined_reason}` : null, o.next_step ? `Next: ${o.next_step}` : null, o.last_touch_on ? `Last touch ${dateOf(o.last_touch_on)}${o.last_touch_via ? ` by ${o.last_touch_via}` : ""}` : null].filter(Boolean).join(" · ") || "No contact yet"}</Sh>
                    </span>
                  </span>
                  <span className="shrink-0 text-[11px]" style={{ color: "var(--bt-muted)" }}><Sh on={loading} chars={2}>{o.messages > 0 ? `${o.messages} ${o.messages === 1 ? "message" : "messages"}${o.last_message_at ? ` · ${dateOf(o.last_message_at)}` : ""}` : "No messages"}</Sh></span>
                </button>
                {!loading && openId === o.id && <ThreadPanel key={`${o.id}-${sentCount}`} base={base} offerId={o.id} request={requestSide} onUpdated={onUpdated} onDraft={(draftId) => setDraft({ offerId: o.id, draftId })} />}
              </li>
            );
          })}
        </ul>
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

/** The open thread inside its offer row: stage, terms, next step, a composer and the messages, each an accordion item. */
function ThreadPanel({ base, offerId, request: requestSide, onUpdated, onDraft }: {
  base: string; offerId: string; request: boolean; onUpdated: () => void; onDraft: (draftId: string) => void;
}) {
  const url = `${base}/${encodeURIComponent(offerId)}`;
  const [drafting, setDrafting] = useState(false);
  const [offer, setOffer] = useState<OfferRow | null>(null);
  const [thread, setThread] = useState<ThreadEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** A lost or declined stage waits here until its reason is written. */
  const [outcomeStage, setOutcomeStage] = useState<"declined" | "lost" | null>(null);
  const [outcomeReason, setOutcomeReason] = useState("");
  /** What the outcome did to the linked stock, or the suggestion when there is no stock link. */
  const [outcomeNote, setOutcomeNote] = useState<string | null>(null);
  /** Paid and Complete wait here until the paid facts are in; "edit" changes them on an offer already paid. */
  const [paidStage, setPaidStage] = useState<"paid" | "complete" | "edit" | null>(null);
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
  const terms = termsLine(current);
  return (
    <BusyRegion busy={loading} label="Loading thread" className="flex w-full flex-col gap-4 pb-4 pl-12 pr-4">
      <div className="flex items-center gap-3">
        <p className="min-w-0 flex-1 truncate text-[12px]" style={{ color: "var(--bt-muted)" }}><Sh on={loading} chars={30}>{[current.contact, current.wants].filter(Boolean).join(" · ") || "No contact details yet"}</Sh></p>
        {offer && (offer.stage === "candidate" || offer.stage === "offered") && (
          <button type="button" disabled={busy || drafting} onClick={() => void draftEmail()} className={`${rowFocus} ${buttonClass} inline-flex items-center gap-1.5`} style={buttonStyle}>
            <Mail size={13} aria-hidden /> {drafting ? "Preparing…" : "Draft email"}
          </button>
        )}
        <select aria-label="Stage" value={outcomeStage ?? current.stage ?? "candidate"} disabled={busy || !offer}
          onChange={(e) => {
            const next = e.target.value as OfferStage;
            if (!offer) { return; }
            // Lost and declined need a reason first, so the stage only saves once it is written.
            if (next === "declined" || next === "lost") { setPaidStage(null); setOutcomeStage(next); setOutcomeReason(offer.declined_reason ?? ""); return; }
            // Paid and Complete need when, how much and our take first, unless the offer already has them.
            if ((next === "paid" || next === "complete") && missingPaidFacts(next, offer).length) { setOutcomeStage(null); setPaidStage(next); return; }
            setOutcomeStage(null); setPaidStage(null); void patch({ stage: next });
          }}
          className="border px-2 py-1 text-[12px]" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
          {STAGES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </div>
      {offer && paidStage && (
        <PaidForm offer={offer} stage={paidStage} busy={busy} onCancel={() => setPaidStage(null)}
          onSave={(facts) => { const stage = paidStage; setPaidStage(null); void patch(stage === "edit" ? facts : { stage, ...facts }); }} />
      )}
      {offer && !paidStage && isPaidStage(offer.stage) && (
        <p className="flex flex-wrap items-center gap-2 text-[12px]" style={{ color: "var(--bt-muted)" }}>
          <span>{paidLine(offer)}</span>
          <button type="button" disabled={busy} className={`${rowFocus} underline`} onClick={() => setPaidStage("edit")}>Edit paid details</button>
        </p>
      )}
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
      {offer?.declined_reason && (offer.stage === "declined" || offer.stage === "lost") && (
        <p className="text-[12px]" style={{ color: "var(--bt-muted)" }}><span className="font-semibold">{STAGE_LABEL[offer.stage]}</span>: {offer.declined_reason}</p>
      )}
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

const money = (amount: number, currency: string) => `${currency} ${amount.toLocaleString("en-GB")}`;

/** "Paid 12 Nov · GBP 18,000 for 12 · take £1,800", or what is still missing. */
function paidLine(offer: Offer): string {
  const missing = missingPaidFacts("paid", offer);
  const parts = [offer.paid_on ? `Paid ${shortDate(offer.paid_on)}` : null,
    offer.paid_amount != null && offer.paid_currency ? money(offer.paid_amount, offer.paid_currency) : null,
    offer.quantity != null ? `for ${offer.quantity.toLocaleString("en-GB")}${offer.terms.unit ? ` ${offer.terms.unit}` : ""}` : null,
    offer.take_gbp != null ? `take £${offer.take_gbp.toLocaleString("en-GB")}` : null].filter(Boolean);
  return missing.length ? `${parts.join(" · ")}${parts.length ? " · " : ""}No ${missing.length === 5 ? "paid details" : missing.map((key) => PAID_FACT_LABEL[key]).join(", ")} yet` : parts.join(" · ");
}

/** When it was paid, what was paid, how much was sold and our take. All five are needed for Paid and Complete. */
function PaidForm({ offer, stage, busy, onSave, onCancel }: {
  offer: Offer; stage: "paid" | "complete" | "edit"; busy: boolean;
  onSave: (facts: { paidOn: string; paidAmount: number; paidCurrency: string; quantity: number; takeGbp: number }) => void; onCancel: () => void;
}) {
  const [paidOn, setPaidOn] = useState(offer.paid_on ?? new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState(offer.paid_amount?.toString() ?? "");
  const [currency, setCurrency] = useState(offer.paid_currency ?? offer.terms.currency?.toUpperCase() ?? "GBP");
  const [quantity, setQuantity] = useState(offer.quantity?.toString() ?? "");
  const [take, setTake] = useState(offer.take_gbp?.toString() ?? "");
  const number = (text: string) => (text.trim() && Number.isFinite(Number(text)) ? Number(text) : null);
  const ready = !!paidOn && number(amount) !== null && number(quantity) !== null && (number(quantity) ?? 0) > 0 && number(take) !== null;
  const field = `${inputClass} w-28 text-[12px]`;
  return (
    <form aria-label="Paid details" className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => { e.preventDefault(); if (ready) onSave({ paidOn, paidAmount: number(amount)!, paidCurrency: currency, quantity: number(quantity)!, takeGbp: number(take)! }); }}>
      <span className="w-full text-[12px]" style={{ color: "var(--bt-muted)" }}>
        {stage === "edit" ? "Paid details" : `${STAGE_LABEL[stage]}: when was it paid, how much, and what is our take?`}
      </span>
      <label className="flex flex-col gap-0.5 text-[11px]" style={{ color: "var(--bt-muted)" }}>Paid on
        <input type="date" required value={paidOn} onChange={(e) => setPaidOn(e.target.value)} className={`${inputClass} text-[12px]`} style={inputStyle} /></label>
      <label className="flex flex-col gap-0.5 text-[11px]" style={{ color: "var(--bt-muted)" }}>Amount paid
        <input inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} className={field} style={inputStyle} /></label>
      <label className="flex flex-col gap-0.5 text-[11px]" style={{ color: "var(--bt-muted)" }}>Currency
        <select value={currency} onChange={(e) => setCurrency(e.target.value)} className="border px-2 py-1 text-[12px]" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
          {PAID_CURRENCIES.map((code) => <option key={code} value={code}>{code}</option>)}
        </select></label>
      <label className="flex flex-col gap-0.5 text-[11px]" style={{ color: "var(--bt-muted)" }}>Quantity{offer.terms.unit ? ` (${offer.terms.unit})` : ""}
        <input inputMode="decimal" required value={quantity} onChange={(e) => setQuantity(e.target.value)} className={field} style={inputStyle} /></label>
      <label className="flex flex-col gap-0.5 text-[11px]" style={{ color: "var(--bt-muted)" }}>Our take (£)
        <input inputMode="decimal" required value={take} onChange={(e) => setTake(e.target.value)} className={field} style={inputStyle} /></label>
      <button type="submit" disabled={busy || !ready} className={`${rowFocus} ${buttonClass}`} style={buttonStyle}>Save</button>
      <button type="button" disabled={busy} className={`${rowFocus} ${buttonClass}`} style={buttonStyle} onClick={onCancel}>Cancel</button>
    </form>
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
