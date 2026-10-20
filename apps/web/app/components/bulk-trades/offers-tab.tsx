"use client";

import { ArrowLeft, Calendar, Mail, MessageCircle, Phone, Plus, Send, StickyNote, Tag, ArrowDownLeft, ArrowUpRight } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Offer, OfferStage, ThreadEntry } from "@/lib/crm-postgres/bulk-offers";
import type { DemandSupply } from "@/lib/demand-supply-types";
import { shortDate } from "@/lib/bulk-trade-details";
import { ErrorText, buttonClass, buttonStyle, inputClass, inputStyle, request } from "./trade-ui";
import { rowFocus } from "./demand-page";

const STAGES: [OfferStage, string][] = [
  ["to_contact", "To contact"], ["teaser_sent", "Teaser sent"], ["specs_nda", "Specs and NDA"], ["bid_in", "Bid in"],
  ["loi", "LOI"], ["won", "Won"], ["declined", "Declined"], ["lost", "Lost"],
];
const STAGE_LABEL = Object.fromEntries(STAGES) as Record<OfferStage, string>;
const STAGE_TONE: Partial<Record<OfferStage, string>> = { bid_in: "var(--bt-amber)", loi: "var(--bt-green)", won: "var(--bt-green)", declined: "var(--bt-red)", lost: "var(--bt-red)" };
const CHANNEL_ICON = { mail: Mail, whatsapp: MessageCircle, call: Phone, note: StickyNote, quote: Tag, status: Tag, document: Tag, other: StickyNote } as const;

const initials = (name: string | null) => (name ?? "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("") || "?";
const dateOf = (iso: string | null) => (iso ? shortDate(iso.slice(0, 10)) : "");
const termsLine = (o: Offer) => {
  const t = o.terms;
  if (t?.amount == null) return null;
  return `${t.amount.toLocaleString("en-GB")} ${t.currency ?? ""}${t.unit ? `/${t.unit}` : ""}${t.firmness ? ` · ${t.firmness}` : ""}`.trim();
};

function StagePill({ stage }: { stage: OfferStage | null }) {
  if (!stage) return null;
  return (
    <span className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium" style={{ background: "var(--bt-segment)", color: STAGE_TONE[stage] ?? "var(--bt-muted)" }}>
      {STAGE_LABEL[stage]}
    </span>
  );
}

function Avatar({ name, size = 32 }: { name: string | null; size?: number }) {
  return (
    <span className="flex shrink-0 items-center justify-center rounded-full text-[12px] font-semibold" aria-hidden
      style={{ width: size, height: size, background: "var(--bt-segment)", color: "var(--bt-text-2)" }}>{initials(name)}</span>
  );
}

/** Who we offered this to, one thread each. Inside a thread: the whole conversation, stage, terms and next step. */
export function OffersTab({ demandId, supply, onChanged }: { demandId: string; supply: DemandSupply | null; onChanged: () => void }) {
  const base = `/api/bulk-trades/demand/${encodeURIComponent(demandId)}/offers`;
  const [offers, setOffers] = useState<Offer[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setOffers((await request<{ offers: Offer[] }>(base)).offers); setError(null); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not load offers."); }
  }, [base]);
  useEffect(() => { void load(); }, [load]);
  if (open) {
    return <Thread base={base} offerId={open} onBack={() => { setOpen(null); void load(); onChanged(); }} />;
  }
  return <OfferList offers={offers} error={error} supply={supply} base={base} onOpen={setOpen} onCreated={(o) => { void load(); onChanged(); setOpen(o.id); }} />;
}

function OfferList({ offers, error, supply, base, onOpen, onCreated }: {
  offers: Offer[] | null; error: string | null; supply: DemandSupply | null; base: string; onOpen: (id: string) => void; onCreated: (o: Offer) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const suggestions = useMemo(() => {
    const have = new Set((offers ?? []).map((o) => (o.name ?? "").toLowerCase()));
    const seen = new Set<string>();
    const out: { name: string; note: string }[] = [];
    for (const g of supply?.groups ?? []) for (const s of g.bySeller) {
      const key = s.name.toLowerCase();
      if (have.has(key) || seen.has(key)) continue;
      seen.add(key);
      out.push({ name: s.name, note: `${s.units.toLocaleString("en-GB")} units · ${g.label}` });
    }
    return out.slice(0, 5);
  }, [offers, supply]);
  async function create(input: { name: string; contact?: string; wants?: string }) {
    setBusy(true); setFormError(null);
    try { onCreated((await request<{ offer: Offer }>(base, { method: "POST", body: JSON.stringify(input) })).offer); setName(""); setContact(""); setAdding(false); }
    catch (err) { setFormError(err instanceof Error ? err.message : "Could not add."); }
    finally { setBusy(false); }
  }
  return (
    <div className="flex w-full flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[13px]" style={{ color: "var(--bt-muted)" }}>
          {offers ? (offers.length ? `${offers.length} ${offers.length === 1 ? "thread" : "threads"}` : "Nobody offered yet") : "Loading…"}
        </p>
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
      {offers && offers.length > 0 && (
        <ul className="flex flex-col">
          {offers.map((o) => {
            const terms = termsLine(o);
            return (
              <li key={o.id} className="border-t first:border-t-0" style={{ borderColor: "var(--bt-divider)" }}>
                <button type="button" onClick={() => onOpen(o.id)} className={`${rowFocus} flex w-full items-center gap-3 px-1 py-3 text-left`}>
                  <Avatar name={o.name} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-[14px] font-semibold">{o.name ?? "Unnamed"}</span>
                      <StagePill stage={o.stage} />
                    </span>
                    <span className="mt-0.5 block truncate text-[12px]" style={{ color: "var(--bt-muted)" }}>
                      {[terms, o.next_step ? `Next: ${o.next_step}` : null, o.last_touch_on ? `Last touch ${dateOf(o.last_touch_on)}${o.last_touch_via ? ` by ${o.last_touch_via}` : ""}` : null].filter(Boolean).join(" · ") || "No contact yet"}
                    </span>
                  </span>
                  {o.messages > 0 && <span className="shrink-0 text-[11px]" style={{ color: "var(--bt-muted)" }}>{o.messages}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {offers && !offers.length && !adding && (
        <p className="text-[13px]" style={{ color: "var(--bt-muted)" }}>Start a thread for each person you offer this to. Their emails and WhatsApp messages, bids and next steps collect there.</p>
      )}
      {suggestions.length > 0 && (
        <section aria-label="Suggested" className="flex flex-col gap-1">
          <h3 className="text-[12px] font-semibold" style={{ color: "var(--bt-muted)" }}>Suggested from our inventory</h3>
          <ul>
            {suggestions.map((s) => (
              <li key={s.name} className="flex items-center gap-3 border-t py-2 first:border-t-0" style={{ borderColor: "var(--bt-divider)" }}>
                <Avatar name={s.name} size={28} />
                <span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-medium">{s.name}</span><span className="block truncate text-[12px]" style={{ color: "var(--bt-muted)" }}>{s.note}</span></span>
                <button type="button" disabled={busy} className={`${rowFocus} ${buttonClass}`} style={buttonStyle} onClick={() => void create({ name: s.name, wants: s.note })}>Start thread</button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Thread({ base, offerId, onBack }: { base: string; offerId: string; onBack: () => void }) {
  const url = `${base}/${encodeURIComponent(offerId)}`;
  const [offer, setOffer] = useState<Offer | null>(null);
  const [thread, setThread] = useState<ThreadEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [kind, setKind] = useState<"note" | "call">("note");
  const [nextStep, setNextStep] = useState("");
  const [nextDue, setNextDue] = useState("");
  const [busy, setBusy] = useState(false);
  const apply = (r: { offer: Offer; thread?: ThreadEntry[] }) => {
    setOffer(r.offer); if (r.thread) setThread(r.thread);
    setNextStep(r.offer.next_step ?? ""); setNextDue(r.offer.next_due ?? "");
  };
  useEffect(() => { let live = true; request<{ offer: Offer; thread: ThreadEntry[] }>(url).then((r) => { if (live) apply(r); }).catch((e) => { if (live) setError(e instanceof Error ? e.message : "Could not load."); }); return () => { live = false; }; }, [url]);
  async function patch(body: Record<string, unknown>) {
    setBusy(true); setError(null);
    try { const r = await request<{ offer: Offer }>(url, { method: "PATCH", body: JSON.stringify(body) }); setOffer(r.offer); const t = await request<{ offer: Offer; thread: ThreadEntry[] }>(url); apply(t); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not save."); } finally { setBusy(false); }
  }
  async function post() {
    if (!text.trim()) return;
    setBusy(true); setError(null);
    try { const line = text.trim(); apply(await request(url, { method: "POST", body: JSON.stringify({ kind, title: line.split("\n")[0].slice(0, 120), body: line.includes("\n") || line.length > 120 ? line : null }) })); setText(""); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not save."); } finally { setBusy(false); }
  }
  if (!offer) return <div className="flex flex-col gap-3"><ErrorText error={error} />{!error && <p className="text-[13px]" style={{ color: "var(--bt-muted)" }}>Loading…</p>}</div>;
  const terms = termsLine(offer);
  return (
    <div className="flex w-full flex-col gap-5">
      <div className="flex items-center gap-3">
        <button type="button" onClick={onBack} aria-label="Back to offers" className={`${rowFocus} inline-flex items-center gap-1 text-[13px]`} style={{ color: "var(--bt-muted)" }}>
          <ArrowLeft size={14} aria-hidden /> Offers
        </button>
      </div>
      <div className="flex items-center gap-3">
        <Avatar name={offer.name} size={40} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[16px] font-semibold">{offer.name}</h3>
          <p className="truncate text-[12px]" style={{ color: "var(--bt-muted)" }}>{[offer.contact, offer.wants].filter(Boolean).join(" · ")}</p>
        </div>
        <select aria-label="Stage" value={offer.stage ?? "to_contact"} disabled={busy} onChange={(e) => void patch({ stage: e.target.value })}
          className="border px-2 py-1 text-[12px]" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
          {STAGES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </div>
      {terms && <p className="text-[13px]"><span style={{ color: "var(--bt-muted)" }}>Latest terms </span><strong>{terms}</strong></p>}
      <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); void patch({ nextStep: nextStep || null, nextDue: nextDue || null }); }}>
        <Calendar size={14} aria-hidden style={{ color: "var(--bt-muted)" }} />
        <input aria-label="Next step" placeholder="Next step" value={nextStep} onChange={(e) => setNextStep(e.target.value)} className={`${inputClass} min-w-[200px] flex-1`} style={inputStyle} />
        <input aria-label="Due" type="date" value={nextDue} onChange={(e) => setNextDue(e.target.value)} className={inputClass} style={inputStyle} />
        <button type="submit" disabled={busy || (nextStep === (offer.next_step ?? "") && nextDue === (offer.next_due ?? ""))} className={`${rowFocus} ${buttonClass}`} style={buttonStyle}>Save</button>
      </form>
      <ErrorText error={error} />
      <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); void post(); }}>
        <textarea aria-label="Add to thread" rows={2} placeholder="Log a note or a call" value={text} onChange={(e) => setText(e.target.value)} className={inputClass} style={inputStyle} />
        <div className="flex items-center gap-2">
          <div role="group" aria-label="Entry type" className="inline-flex gap-1">
            {(["note", "call"] as const).map((k) => (
              <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)} className={`${rowFocus} px-2 py-1 text-[12px]`}
                style={{ background: kind === k ? "var(--bt-badge)" : "var(--bt-segment)", color: kind === k ? "var(--bt-on-badge)" : "var(--bt-muted)" }}>{k === "note" ? "Note" : "Call"}</button>
            ))}
          </div>
          <button type="submit" disabled={busy || !text.trim()} className={`${rowFocus} ${buttonClass} ml-auto inline-flex items-center gap-1.5`} style={buttonStyle}><Send size={13} aria-hidden /> Add</button>
        </div>
      </form>
      <section aria-label="Thread">
        {thread.length === 0 && <p className="text-[13px]" style={{ color: "var(--bt-muted)" }}>Nothing yet. Email and WhatsApp with this person appear here once they are linked to a CRM person or email.</p>}
        <ul>
          {thread.map((e) => {
            const Icon = CHANNEL_ICON[e.channel];
            const Dir = e.direction === "inbound" ? ArrowDownLeft : e.direction === "outbound" ? ArrowUpRight : null;
            return (
              <li key={e.id} className="flex gap-3 border-t py-3 first:border-t-0" style={{ borderColor: "var(--bt-divider)" }}>
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full" style={{ background: "var(--bt-segment)", color: "var(--bt-muted)" }}><Icon size={13} aria-hidden /></span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-semibold">{e.title}</span>
                    {Dir && <Dir size={12} aria-label={e.direction ?? ""} style={{ color: "var(--bt-muted)" }} />}
                    <time className="ml-auto shrink-0 text-[11px] font-bold" style={{ color: "var(--bt-text-2)" }} dateTime={e.at}>{dateOf(e.at)}</time>
                  </div>
                  {e.body && <p className="mt-0.5 line-clamp-4 whitespace-pre-wrap text-[12px]" style={{ color: "var(--bt-muted)" }}>{e.body}</p>}
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
