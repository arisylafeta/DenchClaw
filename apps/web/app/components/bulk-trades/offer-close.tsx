"use client";

// Offer to close, on the open offer: the seller-quote gate for a buyer offer, the one next step with what it needs, the
// offer's price and terms, the margin (staff only, never sent) and the price sheets kept with the deal's documents.
import { FileSpreadsheet } from "lucide-react";
import { useState } from "react";
import type { Offer, OfferStage, OfferTerms } from "@/lib/crm-postgres/bulk-offers";
import type { OfferClose } from "@/lib/crm-postgres/bulk-offer-close";
import { NEXT_STEP, quoteDay, stepGaps, type Margin } from "@/lib/bulk-offer-close";
import { ErrorText, buttonClass, buttonStyle, darkButtonClass, darkButtonStyle, inputClass, inputStyle, request } from "./trade-ui";
import { rowFocus } from "./demand-page";

const muted = { color: "var(--bt-muted)" };
const amber = { color: "var(--bt-amber)" };
const todayIso = () => new Date().toISOString().slice(0, 10);
const figure = (n: number) => n.toLocaleString("en-GB", { maximumFractionDigits: 2 });

/**
 * A buyer offer whose seller quote is missing, unconfirmed or out of date: the reason, the seller re-confirm draft, and a
 * way to record the seller's answer. In date, one quiet line.
 */
export function QuoteGateNote({ close, listingId, onDraft, onChanged }: {
  close: OfferClose; listingId: string; onDraft: (draftId: string) => void; onChanged: () => void;
}) {
  const [until, setUntil] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (close.side !== "buyer" || !close.gate) {
    return null;
  }
  if (close.gate.ok) {
    return <p className="text-[12px]" style={muted}>Seller&apos;s quote holds until {quoteDay(close.gate.validUntil)}.</p>;
  }
  const base = `/api/bulk-listings/${encodeURIComponent(listingId)}/stored-matches`;
  async function act(body: Record<string, unknown>, after?: (result: { draftId?: string }) => void) {
    setBusy(true); setError(null);
    try { const result = await request<{ draftId?: string }>(base, { method: "POST", body: JSON.stringify(body) }); after?.(result); onChanged(); }
    catch (err) { setError(err instanceof Error ? err.message : "That did not work."); }
    finally { setBusy(false); }
  }
  return (
    <div role="status" className="flex flex-col gap-2 border p-2.5 text-[12px]" style={{ borderColor: "var(--bt-amber-border)", background: "var(--bt-amber-bg)" }}>
      <p style={amber}>{close.gate.reason} No offer goes to this buyer until then.</p>
      <div className="flex flex-wrap items-end gap-2">
        <button type="button" disabled={busy} className={`${rowFocus} ${buttonClass}`} style={buttonStyle}
          onClick={() => void act({ action: "reconfirm" }, (r) => { if (r.draftId) onDraft(r.draftId); })}>Draft re-confirm to seller</button>
        <label className="flex flex-col gap-0.5 text-[11px]" style={muted}>Seller confirmed, holds until
          <input aria-label="Seller quote holds until" type="date" min={todayIso()} value={until} onChange={(e) => setUntil(e.target.value)}
            className={`${inputClass} text-[12px]`} style={inputStyle} /></label>
        <button type="button" disabled={busy || !until} className={`${rowFocus} ${buttonClass}`} style={buttonStyle}
          onClick={() => void act({ action: "quote", validUntil: until })}>Save</button>
      </div>
      <ErrorText error={error} />
    </div>
  );
}

/**
 * The one primary move for this stage and what it needs. Candidate drafts the email (sending marks it Offered), Invoice
 * out opens the paid details, everything else moves one stage on. Declined and Lost stay in the stage menu, with a reason.
 */
export function NextStepBar({ offer, close, busy, drafting, onDraft, onMove, onPaid }: {
  offer: Offer; close: OfferClose | null; busy: boolean; drafting: boolean;
  onDraft: () => void; onMove: (to: OfferStage) => void; onPaid: (to: "paid" | "complete") => void;
}) {
  const stage = offer.stage ?? "candidate";
  const step = NEXT_STEP[stage];
  if (!step) {
    return null;
  }
  const blocked = close?.side === "buyer" && close.gate && !close.gate.ok ? close.gate.reason : null;
  const gaps = stepGaps(step.to, { terms: { ...offer.terms, expires_on: offer.terms.expires_on ?? close?.expiresOn ?? undefined }, quantity: offer.quantity ?? close?.quantity ?? null });
  const drafts = stage === "candidate";
  const disabled = busy || drafting || (drafts && !!blocked) || gaps.length > 0;
  const needs = gaps.length ? `Add the ${gaps.join(", ")} first.` : drafts && blocked ? "Waiting on the seller's quote." : step.needs;
  return (
    <div className="flex flex-wrap items-center gap-2" data-next-step={step.to}>
      <button type="button" disabled={disabled} className={`${rowFocus} ${darkButtonClass}`} style={darkButtonStyle}
        onClick={() => {
          if (drafts) onDraft();
          else if (step.to === "paid" || step.to === "complete") onPaid(step.to);
          else onMove(step.to);
        }}>
        {drafts && drafting ? "Preparing…" : step.label}
      </button>
      <span className="text-[12px]" style={gaps.length ? amber : muted}>{needs}</span>
    </div>
  );
}

/** "Margin GBP 4,800 (GBP 400 per pack x 12) · take about £4,800 · 16.7% of the sale", or why there is none. Staff only. */
export function marginLine(margin: Margin): string {
  if (!margin.ok) {
    return `No margin yet: ${margin.why}`;
  }
  const approx = margin.approx ? "about " : "";
  return `Margin ${approx}${margin.currency} ${figure(margin.total)} (${margin.currency} ${figure(margin.perUnit)} per ${margin.unit} x ${figure(margin.quantity)})`
    + ` · take ${approx}£${figure(margin.takeGbp)}${margin.feePct != null ? ` · ${margin.feePct}% of the sale` : ""}`;
}

const UNITS = ["pack", "module", "cell", "unit", "kWh", "MWh", "kg", "lot"];

/**
 * The offer's price and terms. To a buyer: the buyer price (never the seller's), quantity, delivery and the last day,
 * which defaults to the seller quote's and may not be later. Below it the margin for staff and the price sheets.
 */
export function TermsBlock({ offer, close, url, busy, onSave }: {
  offer: Offer; close: OfferClose | null; url: string; busy: boolean;
  onSave: (body: { terms: OfferTerms; quantity: number | null }) => void;
}) {
  const buyer = close?.side === "buyer";
  const t = offer.terms ?? {};
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(t.amount?.toString() ?? "");
  const [currency, setCurrency] = useState(t.currency?.toUpperCase() ?? "GBP");
  const [unit, setUnit] = useState(t.unit ?? "pack");
  const [quantity, setQuantity] = useState((offer.quantity ?? close?.quantity)?.toString() ?? "");
  const [delivery, setDelivery] = useState(t.delivery_terms ?? "");
  const [until, setUntil] = useState(t.expires_on ?? close?.expiresOn ?? "");
  const [sheet, setSheet] = useState<{ reference: string; file: string; skipped: number } | null>(null);
  const [sheetBusy, setSheetBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cap = buyer && close?.gate?.validUntil ? close.gate.validUntil : undefined;
  const number = (text: string) => (text.trim() && Number.isFinite(Number(text)) ? Number(text) : null);
  const late = !!cap && !!until && until > cap;
  const ready = number(amount) !== null && (number(amount) ?? 0) > 0 && !late;
  async function makeSheet(kind: "overview" | "fixed") {
    setSheetBusy(true); setError(null);
    try {
      const r = await request<{ reference: string; file: string; skipped: unknown[] }>(`${url}/sheet`, { method: "POST", body: JSON.stringify({ kind }) });
      setSheet({ reference: r.reference, file: r.file, skipped: r.skipped.length });
    } catch (err) { setError(err instanceof Error ? err.message : "Could not make the sheet."); }
    finally { setSheetBusy(false); }
  }
  const gateOk = !buyer || !!close?.gate?.ok;
  return (
    <div className="flex flex-col gap-2 text-[12px]">
      <div className="flex flex-wrap items-center gap-2">
        <span style={muted}>{buyer ? "Buyer price" : "Price"}</span>
        <strong className="text-[13px]">
          {t.amount != null ? `${t.currency ?? ""} ${figure(t.amount)}${t.unit ? ` per ${t.unit}` : ""}` : "Not recorded"}
        </strong>
        {(offer.quantity ?? close?.quantity) != null && <span style={muted}>x {figure((offer.quantity ?? close?.quantity)!)}</span>}
        {t.delivery_terms && <span style={muted}>· {t.delivery_terms}</span>}
        {(t.expires_on ?? close?.expiresOn) && <span style={muted}>· valid until {quoteDay((t.expires_on ?? close?.expiresOn)!)}</span>}
        <button type="button" disabled={busy} className={`${rowFocus} underline`} onClick={() => setOpen(!open)}>{open ? "Close" : "Edit"}</button>
      </div>
      {open && (
        <form aria-label="Offer terms" className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!ready) return;
            onSave({
              terms: { ...t, amount: number(amount)!, currency, unit, delivery_terms: delivery.trim() || undefined, expires_on: until || undefined },
              quantity: number(quantity),
            });
            setOpen(false);
          }}>
          <label className="flex flex-col gap-0.5 text-[11px]" style={muted}>{buyer ? "Buyer price" : "Price"}
            <input aria-label="Price" inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} className={`${inputClass} w-28 text-[12px]`} style={inputStyle} /></label>
          <label className="flex flex-col gap-0.5 text-[11px]" style={muted}>Currency
            <select aria-label="Price currency" value={currency} onChange={(e) => setCurrency(e.target.value)} className="h-9 border px-2 text-[12px]" style={inputStyle}>
              {["GBP", "EUR", "USD"].map((c) => <option key={c}>{c}</option>)}
            </select></label>
          <label className="flex flex-col gap-0.5 text-[11px]" style={muted}>Per
            <select aria-label="Price per" value={unit} onChange={(e) => setUnit(e.target.value)} className="h-9 border px-2 text-[12px]" style={inputStyle}>
              {UNITS.map((u) => <option key={u}>{u}</option>)}
            </select></label>
          <label className="flex flex-col gap-0.5 text-[11px]" style={muted}>Quantity
            <input aria-label="Offer quantity" inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value)} className={`${inputClass} w-24 text-[12px]`} style={inputStyle} /></label>
          <label className="flex flex-col gap-0.5 text-[11px]" style={muted}>Delivery
            <input aria-label="Delivery terms" placeholder="e.g. DAP buyer's site" value={delivery} onChange={(e) => setDelivery(e.target.value)} className={`${inputClass} w-44 text-[12px]`} style={inputStyle} /></label>
          <label className="flex flex-col gap-0.5 text-[11px]" style={muted}>Valid until
            <input aria-label="Valid until" type="date" max={cap} value={until} onChange={(e) => setUntil(e.target.value)} className={`${inputClass} text-[12px]`} style={inputStyle} /></label>
          <button type="submit" disabled={busy || !ready} className={`${rowFocus} ${buttonClass}`} style={buttonStyle}>Save</button>
          {late && <span className="w-full" style={amber}>The offer cannot run past the seller&apos;s quote, which ends on {quoteDay(cap!)}.</span>}
        </form>
      )}
      {buyer && close?.margin && (
        <p data-margin className="text-[12px]" style={muted} title="For us only. Never on a sheet or in an email.">
          <span className="font-semibold">For us only.</span> {marginLine(close.margin)}
        </p>
      )}
      {buyer && (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" disabled={sheetBusy || !gateOk || t.amount == null} className={`${rowFocus} ${buttonClass}`} style={buttonStyle} onClick={() => void makeSheet("overview")}>
            <FileSpreadsheet size={13} aria-hidden /> Price overview
          </button>
          <button type="button" disabled={sheetBusy || !gateOk || t.amount == null || (offer.quantity ?? close?.quantity) == null} className={`${rowFocus} ${buttonClass}`} style={buttonStyle} onClick={() => void makeSheet("fixed")}>
            <FileSpreadsheet size={13} aria-hidden /> Fixed price sheet
          </button>
          {sheet && (
            <span role="status" style={muted}>
              Saved {sheet.reference} to Documents. <a className="underline" href={sheet.file}>Download</a>
              {sheet.skipped ? ` ${sheet.skipped} other ${sheet.skipped === 1 ? "lot was" : "lots were"} left out: no price or no in-date quote.` : ""}
            </span>
          )}
        </div>
      )}
      <ErrorText error={error} />
    </div>
  );
}
