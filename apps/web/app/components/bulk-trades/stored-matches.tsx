"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { StoredMatches, StoredMatchView } from "@/lib/crm-postgres/bulk-matches";
import { Button, Chip, LinkButton, type ChipTone } from "@/components/ui/board";
import { MailDraftView } from "../crm/inbox/mail-draft-view";
import { DetailSheet, ErrorText, inputClass, inputStyle, request } from "./trade-ui";
import { rowFocus } from "./demand-page";
import css from "./demand-panel.module.css";

const STATE_LABEL: Record<string, { label: string; tone: ChipTone }> = {
  proposed: { label: "Proposed", tone: "neutral" },
  asked: { label: "Asked", tone: "blue" },
  confirmed: { label: "Yes", tone: "green" },
  offered: { label: "Offered", tone: "accent" },
  declined: { label: "No", tone: "red" },
  replaced: { label: "Replaced", tone: "neutral" },
  expired: { label: "Expired", tone: "amber" },
};

/** The reasons Alex gives for a no, as on the live list. Any detail goes in the text field. */
const NO_REASONS = ["Price", "Sold elsewhere", "Wrong format", "Wrong chemistry", "No longer buying", "Other"] as const;

const shortDay = (iso: string | null) => (iso ? new Date(`${iso.slice(0, 10)}T00:00:00Z`)
  .toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }) : "");
const count = (value: number) => value.toLocaleString("en-GB", { maximumFractionDigits: 1 });
const todayIso = () => new Date().toISOString().slice(0, 10);

/** "Reserved 10 until 19 Nov" on this match, and how much of the candidate is held across deals. */
function reservationLine(row: StoredMatchView): string | null {
  const parts: string[] = [];
  if (row.reservation_live && row.reserved_until) {
    parts.push(`Reserved ${row.reserved_qty != null ? count(row.reserved_qty) : "the lot"} until ${shortDay(row.reserved_until)}`);
  } else if (row.state === "offered" && row.reserved_until) {
    parts.push(`Reservation lapsed on ${shortDay(row.reserved_until)}`);
  }
  const held = row.stock_reserved;
  if (held.holds > 0 && !(row.reservation_live && held.holds === 1)) {
    parts.push(row.candidate_qty != null && held.whole === 0
      ? `${count(held.qty)} of ${count(row.candidate_qty)} reserved across deals`
      : `${held.holds} ${held.holds === 1 ? "reservation" : "reservations"} across deals`);
  }
  return parts.length ? parts.join(" · ") : null;
}

type Checks = { checks?: string[]; fit?: { key: string; label: string; state: string }[]; reason?: string; holds?: string; price?: string };

/** What the scorer found, shown when a row is opened. */
function ChecksView({ row }: { row: StoredMatchView }) {
  const checks = row.checks as Checks;
  const scoredBy = row.scored_by as { model?: string | null; fallback?: string };
  return (
    <div className="mt-2 flex flex-col gap-1 border-l pl-3 text-[12px]" style={{ borderColor: "var(--color-border)", color: "var(--color-text-secondary)" }}>
      {checks.reason && <p>Scorer: {checks.reason}</p>}
      {checks.holds && <p>Holds: {checks.holds}</p>}
      {checks.fit?.map((mark) => <p key={mark.key}>{mark.key}: {mark.label} ({mark.state === "unstated" ? "not stated" : mark.state})</p>)}
      {checks.checks?.length ? <p>Check: {checks.checks.join(" · ")}</p> : null}
      {checks.price && <p>Their price: {checks.price}</p>}
      <p style={{ color: "var(--color-text-muted)" }}>
        Scorer rank {row.scorer_rank ?? "?"}{row.rank != null ? `, shown ${row.rank}` : ""}
        {scoredBy.model ? ` · ordered by ${scoredBy.model}` : " · scorer order"}{scoredBy.fallback ? ` (${scoredBy.fallback})` : ""}
      </p>
    </div>
  );
}

function YesForm({ demand, busy, onSave, onCancel }: {
  demand: boolean; busy: boolean; onSave: (body: Record<string, unknown>) => void; onCancel: () => void;
}) {
  const [qty, setQty] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("EUR");
  const [unit, setUnit] = useState("unit");
  const [until, setUntil] = useState("");
  const ready = !demand || !!until;
  return (
    <form
      className="mt-2 flex flex-col gap-2 rounded-lg border p-2.5 text-[12px]"
      style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
      aria-label="Record a yes"
      onSubmit={(event) => {
        event.preventDefault();
        onSave({
          quantity: qty || null,
          ...(demand && amount ? { quote: { amount: Number(amount), currency, unit } } : {}),
          validUntil: until || null,
        });
      }}
    >
      <label className="flex flex-col gap-1">{demand ? "How many they can supply" : "How many they would take"} (optional)
        <input aria-label="Quantity" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} className={inputClass} style={inputStyle} />
      </label>
      {demand && (
        <div className="flex flex-wrap gap-2">
          <label className="flex flex-col gap-1">Their price
            <input aria-label="Price" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className={inputClass} style={inputStyle} />
          </label>
          <label className="flex flex-col gap-1">Currency
            <select aria-label="Currency" value={currency} onChange={(e) => setCurrency(e.target.value)} className={inputClass} style={inputStyle}>
              {["EUR", "GBP", "USD"].map((c) => <option key={c}>{c}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">Per
            <select aria-label="Price unit" value={unit} onChange={(e) => setUnit(e.target.value)} className={inputClass} style={inputStyle}>
              {["unit", "kWh", "kg", "lot"].map((u) => <option key={u}>{u}</option>)}
            </select>
          </label>
        </div>
      )}
      {demand && (
        <label className="flex flex-col gap-1">Their quote holds until
          <input aria-label="Quote holds until" type="date" min={todayIso()} value={until} onChange={(e) => setUntil(e.target.value)} className={inputClass} style={inputStyle} required />
        </label>
      )}
      <p style={{ color: "var(--color-text-muted)" }}>This adds them to Offers as a candidate. Nothing is sent.</p>
      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary" size="xs" disabled={!ready || busy}>{busy ? "Saving…" : "Save yes"}</Button>
        <LinkButton variant="secondary" size="xs" onClick={onCancel}>Cancel</LinkButton>
      </div>
    </form>
  );
}

function NoForm({ busy, onSave, onCancel }: { busy: boolean; onSave: (reason: string) => void; onCancel: () => void }) {
  const [quick, setQuick] = useState<string | null>(null);
  const [note, setNote] = useState("");
  return (
    <form
      className="mt-2 flex flex-col gap-2 rounded-lg border p-2.5"
      style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
      aria-label="Record a no"
      onSubmit={(event) => { event.preventDefault(); if (quick) onSave(note.trim() ? `${quick}: ${note.trim()}` : quick); }}
    >
      <div className="flex flex-wrap gap-1.5">
        {NO_REASONS.map((reason) => (
          <button key={reason} type="button" aria-pressed={quick === reason} onClick={() => setQuick(quick === reason ? null : reason)}
            className={`${rowFocus} rounded-md border px-2 py-1 text-[12px]`}
            style={{ borderColor: quick === reason ? "var(--color-text)" : "var(--color-border)", fontWeight: quick === reason ? 600 : 400 }}>
            {reason}
          </button>
        ))}
      </div>
      <input aria-label="Anything else" maxLength={160} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything else (optional)"
        className="w-full rounded-md border px-2 py-1.5 text-[12px]" style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }} />
      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary" size="xs" disabled={!quick || busy}>{busy ? "Saving…" : "Save no"}</Button>
        <LinkButton variant="secondary" size="xs" onClick={onCancel}>Cancel</LinkButton>
      </div>
    </form>
  );
}

/** The supply deal's seller quote: in date, or a re-confirm to draft and a way to record it once the seller answers. */
function SellerQuoteBar({ data, busy, onReconfirm, onQuote }: {
  data: StoredMatches; busy: boolean; onReconfirm: () => void; onQuote: (until: string) => void;
}) {
  const [until, setUntil] = useState("");
  const quote = data.sellerQuote;
  if (!quote) {
    return null;
  }
  if (quote.inDate) {
    return <p className="text-[12px]" style={{ color: "var(--color-text-muted)" }}>Seller&apos;s quote holds until {shortDay(quote.validUntil)}.</p>;
  }
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-2.5 text-[12px]" style={{ borderColor: "var(--color-border)" }}>
      <p>
        {quote.validUntil ? `The seller's quote ran out on ${shortDay(quote.validUntil)}.` : "The seller has not confirmed a quote with an end date."}
        {" "}Buyers can be asked once the seller confirms it.
        {data.reconfirm ? ` Re-confirm drafted ${shortDay(data.reconfirm.at)}.` : ""}
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <Button variant="secondary" size="xs" disabled={busy} onClick={onReconfirm}>Draft re-confirm to seller</Button>
        <label className="flex flex-col gap-1">Seller confirmed, holds until
          <input aria-label="Seller quote holds until" type="date" min={todayIso()} value={until} onChange={(e) => setUntil(e.target.value)} className={inputClass} style={inputStyle} />
        </label>
        <Button variant="secondary" size="xs" disabled={busy || !until} onClick={() => onQuote(until)}>Save</Button>
      </div>
    </div>
  );
}

/**
 * The stored five for a deal, in order, with why each is here, its state and the next action: Ask (a draft to read and
 * send), Yes (an offer at candidate), No (with a reason; the next best comes in), and Extend or Release on a reservation.
 */
export function StoredMatchesView({ dealId, kind, onOpenOffers, onLoaded }: {
  dealId: string; kind: "supply" | "demand"; onOpenOffers?: () => void;
  /** Told once the stored matches are read, with whether the deal has had a run. */
  onLoaded?: (hasRun: boolean) => void;
}) {
  const base = `/api/bulk-listings/${encodeURIComponent(dealId)}/stored-matches`;
  const [data, setData] = useState<StoredMatches | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [form, setForm] = useState<{ id: string; kind: "yes" | "no" } | null>(null);
  const [draft, setDraft] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const payload = await request<StoredMatches>(base);
      if (!payload?.deal || !Array.isArray(payload.matches)) {
        throw new Error("Could not read them.");
      }
      setData(payload);
      setError(null);
      onLoaded?.(!!payload.run);
    } catch (err) {
      setError(`Stored matches: ${err instanceof Error ? err.message : "could not load them."}`);
    }
  }, [base, onLoaded]);
  useEffect(() => { void load(); }, [load]);

  async function act(key: string, url: string, body: Record<string, unknown>, after?: (result: unknown) => void) {
    setBusy(key);
    setError(null);
    try {
      const result = await request<unknown>(url, { method: "POST", body: JSON.stringify(body) });
      after?.(result);
      setForm(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not work.");
    } finally {
      setBusy(null);
    }
  }
  const matchUrl = (row: StoredMatchView) => `${base}/${encodeURIComponent(row.id)}`;
  const showDraft = (result: unknown) => {
    const id = (result as { draftId?: string } | null)?.draftId;
    if (id) setDraft(id);
  };

  if (!data && !error) {
    return <div role="status" aria-live="polite" className="h-[58px] animate-pulse rounded-lg" style={{ background: "var(--color-surface-hover)" }}><span className="sr-only">Loading matches</span></div>;
  }
  const quoteBlocked = kind === "supply" && !!data?.sellerQuote && !data.sellerQuote.inDate;

  return (
    <div className="flex w-full min-w-0 flex-col gap-3">
      <h3 className="text-[13px] font-semibold">Top five</h3>
      <ErrorText error={error} />
      {data && !data.deal.qualified && (
        <p className="text-[12px]" style={{ color: "var(--bt-amber, var(--color-text-muted))" }}>
          This deal is not qualified yet, so matches may be thin. You can still look.
        </p>
      )}
      {data && (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant={data.run ? "secondary" : "primary"} size="small" disabled={busy === "run"} onClick={() => void act("run", base, { action: "run" })}>
            {busy === "run" ? "Finding…" : data.run ? "Find matches again" : "Find matches"}
          </Button>
          {data.run && <span className="text-[12px]" style={{ color: "var(--color-text-muted)" }}>Last run {shortDay(data.run.at)}{data.run.by ? ` by ${data.run.by}` : ""}</span>}
        </div>
      )}
      {data && kind === "supply" && <SellerQuoteBar data={data} busy={!!busy}
        onReconfirm={() => void act("reconfirm", base, { action: "reconfirm" }, showDraft)}
        onQuote={(until) => void act("quote", base, { action: "quote", validUntil: until })} />}
      {data?.run && !data.matches.length && <p className={css.empty}>Nothing fits right now. Try again when new supply or buyers come in.</p>}

      {!!data?.matches.length && (
        <ul className="flex flex-col">
          {data.matches.map((row) => {
            const state = STATE_LABEL[row.state] ?? { label: row.state, tone: "neutral" as ChipTone };
            const reserved = reservationLine(row);
            const canAnswer = row.state === "proposed" || row.state === "asked";
            return (
              <li key={row.id} className="border-t py-3 first:border-t-0 first:pt-0" style={{ borderColor: "var(--color-border)" }}>
                <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
                  <span className="w-5 shrink-0 pt-0.5 text-right text-[12px] tabular-nums" style={{ color: "var(--color-text-muted)" }}>{row.rank}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate text-[14px] font-semibold">{row.name}</span>
                      <Chip tone={state.tone}>{state.label}</Chip>
                    </div>
                    <p className="mt-0.5 text-[13px]">{row.reason}</p>
                    {row.asked && <p className="text-[12px]" style={{ color: "var(--color-text-muted)" }}>{row.asked.label}</p>}
                    {reserved && <p className="text-[12px] font-medium">{reserved}</p>}
                    {row.note && <p className="text-[12px]" style={{ color: "var(--color-text-muted)" }}>{row.note}</p>}
                    <button type="button" aria-expanded={open === row.id} className={`${rowFocus} mt-1 inline-flex items-center gap-1 rounded text-[12px]`}
                      style={{ color: "var(--color-text-muted)" }} onClick={() => setOpen(open === row.id ? null : row.id)}>
                      {open === row.id ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />} Why
                    </button>
                    {open === row.id && <ChecksView row={row} />}
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2 pl-8 sm:pl-0">
                    {canAnswer && (
                      <Button variant="secondary" size="small" disabled={!!busy || quoteBlocked}
                        title={quoteBlocked ? "Confirm the seller's quote first" : undefined}
                        onClick={() => void act(`ask:${row.id}`, matchUrl(row), { action: "ask" }, showDraft)}>
                        {busy === `ask:${row.id}` ? "Drafting…" : row.state === "asked" ? "Open draft" : "Ask"}
                      </Button>
                    )}
                    {canAnswer && <LinkButton variant="secondary" size="xs" onClick={() => setForm({ id: row.id, kind: "yes" })}>Yes</LinkButton>}
                    {canAnswer && <LinkButton variant="secondary" size="xs" onClick={() => setForm({ id: row.id, kind: "no" })}>No</LinkButton>}
                    {(row.state === "confirmed" || row.state === "offered") && onOpenOffers && (
                      <LinkButton variant="secondary" size="xs" onClick={onOpenOffers}>{row.offer_stage ? `In offers · ${row.offer_stage}` : "In offers"}</LinkButton>
                    )}
                    {row.state === "offered" && (
                      <LinkButton variant="secondary" size="xs" disabled={!!busy} onClick={() => void act(`extend:${row.id}`, matchUrl(row), { action: "extend" })}>
                        {row.reservation_live ? "Extend" : "Reserve again"}
                      </LinkButton>
                    )}
                    {row.state === "offered" && row.reservation_live && (
                      <LinkButton variant="secondary" size="xs" disabled={!!busy} onClick={() => void act(`release:${row.id}`, matchUrl(row), { action: "release" })}>Release</LinkButton>
                    )}
                  </div>
                </div>
                {form?.id === row.id && form.kind === "yes" && (
                  <YesForm demand={kind === "demand"} busy={busy === `yes:${row.id}`} onCancel={() => setForm(null)}
                    onSave={(body) => void act(`yes:${row.id}`, matchUrl(row), { action: "yes", ...body })} />
                )}
                {form?.id === row.id && form.kind === "no" && (
                  <NoForm busy={busy === `no:${row.id}`} onCancel={() => setForm(null)}
                    onSave={(reason) => void act(`no:${row.id}`, matchUrl(row), { action: "no", reason })} />
                )}
              </li>
            );
          })}
        </ul>
      )}

      {!!data?.markers.length && (
        <section aria-label="New supply that may fit">
          <h4 className="text-[12px] font-semibold">New supply may fit</h4>
          <ul className="mt-1 flex flex-col gap-1 text-[12px]">
            {data.markers.map((row) => <li key={row.id}>{row.name}: {row.reason}</li>)}
          </ul>
          <p className="text-[12px]" style={{ color: "var(--color-text-muted)" }}>Find matches again to weigh these against the five.</p>
        </section>
      )}

      {!!data?.past.length && (
        <details className="text-[12px]">
          <summary className={`${rowFocus} cursor-pointer`} style={{ color: "var(--color-text-muted)" }}>Answered before ({data.past.length})</summary>
          <ul className="mt-1 flex flex-col gap-1">
            {data.past.map((row) => (
              <li key={row.id}>{row.name}: {STATE_LABEL[row.state]?.label ?? row.state}{row.verdict_reason ? ` (${row.verdict_reason})` : ""}{row.note ? `. ${row.note}` : ""}</li>
            ))}
          </ul>
        </details>
      )}

      {draft && (
        <DetailSheet title="Email draft" onClose={() => setDraft(null)}>
          <MailDraftView draftId={draft} onSent={() => void load()} />
        </DetailSheet>
      )}
    </div>
  );
}
