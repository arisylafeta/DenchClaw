"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { dealTotals, deskCounts, EUR_PER_GBP, openDealRows, TAKE_TARGET, todayGroups, type TodayGroupKey } from "@/lib/bulk-desk";
import { ACTIVE_DEAL_LIMIT, dealWaiting, overdueByOwner, overLimit, STUCK_NEW_DAYS, stuckInNew, waitingLabel, type Mention } from "@/lib/bulk-today";
import { formatEurCompact, type SheetRow } from "@/lib/bulk-sheet";
import type { DealOwner } from "@/lib/bulk-owner";
import { BusyRegion, Sh } from "./bt-shimmer";
import { NextActionCell } from "./next-action-cell";
import { ProgressChip } from "./opportunities-sheet";
import { DriverAvatar, DueText } from "./desk-bits";
import { ErrorText, request } from "./trade-ui";
import { DossiersToReview } from "./dossiers-to-review";
import { ScorecardBlock } from "./scorecard-block";

/** Whole thousands for the target, e.g. £15k, €17k. */
const roundK = (symbol: string, value: number) => `${symbol}${Math.round(value / 1000).toLocaleString("en-GB")}k`;
const percent = (part: number, whole: number) => (whole > 0 ? Math.min(100, Math.round((part / whole) * 100)) : 0);

function Meter({ label, hint, value, of, focal = false, loading }: { label: string; hint: string; value: number; of: number; focal?: boolean; loading: boolean }) {
  const pct = percent(value, of);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className="text-[13px] font-medium">{label} <span className="font-normal" style={{ color: "var(--bt-muted)" }}>{hint}</span></span>
        <span className="text-[13px] tabular-nums">
          <Sh on={loading} chars={12}><span className="font-semibold">{formatEurCompact(value)}</span> <span style={{ color: "var(--bt-muted)" }}>of {roundK("€", of)} · {pct}%</span></Sh>
        </span>
      </div>
      <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={loading ? undefined : pct}
        className="h-2 overflow-hidden rounded-full" style={{ background: "var(--bt-segment)" }}>
        {!loading && <div className="h-full rounded-full" style={{ width: `${pct}%`, background: focal ? "var(--bt-accent)" : "var(--bt-border-strong)" }} />}
      </div>
    </div>
  );
}

/** Open deals on the Board (Offered to Paid) against the one bulk target: take for the desk over Dec 2026 to Feb 2027.
 * Their fees weighted by chance, not take banked: banked take is on the OKR page. */
export function TakeTarget({ rows, owner, loading, onOpenBoard }: { rows: SheetRow[]; owner: DealOwner | "all"; loading: boolean; onOpenBoard: () => void }) {
  const totals = dealTotals(openDealRows(rows));
  return (
    <section aria-label="Pipeline against the take target" className="flex flex-col gap-3 rounded-xl border p-4" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-[14px] font-semibold">Pipeline against the take target{owner !== "all" && <span className="font-normal" style={{ color: "var(--bt-muted)" }}> · {owner}&apos;s deals</span>}</h2>
        <span className="text-[14px] font-semibold tabular-nums" title={`Approx. at €${EUR_PER_GBP} to £1`}>
          {roundK("£", TAKE_TARGET.gbp)} <span className="font-normal" style={{ color: "var(--bt-muted)" }}>(≈ {roundK("€", TAKE_TARGET.eur)}) Dec to Feb</span>
        </span>
      </header>
      <Meter label="Weighted fees" hint="fee × chance" value={totals.weighted_eur} of={TAKE_TARGET.eur} focal loading={loading} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12px]" style={{ color: "var(--bt-muted)" }}>
          Open deals on the Board, Offered to Paid, against the desk&apos;s take target for Dec 2026 to Feb 2027. Not take banked; that is on the OKR page.{owner === "all" && " Includes deals with no owner."} Euro amounts approx. at €{EUR_PER_GBP} to £1.
        </p>
        {!loading && totals.unsized > 0 && (
          <button type="button" onClick={onOpenBoard} data-unsized-nudge
            className="inline-flex h-8 items-center rounded-lg border px-3 text-[12px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--bt-text-2)]"
            style={{ color: "var(--bt-amber)", background: "var(--bt-amber-bg)", borderColor: "var(--bt-amber-border)" }}>
            {totals.unsized} {totals.unsized === 1 ? "deal needs" : "deals need"} a fee or chance
          </button>
        )}
      </div>
    </section>
  );
}

const GROUP_TONE: Partial<Record<TodayGroupKey, string>> = { overdue: "var(--bt-red)", today: "var(--bt-blue)" };

/** What the row is: a request, a supply lot, or a deal once it is offered. */
const kindLabel = (row: SheetRow) => (row.deal_stage ? "Deal" : row.kind === "demand" ? "Request" : "Supply");

/** One task: the next action to do, where it belongs underneath, when it is due and who drives it on the right. */
function ActionRow({ row, today, onOpen, onNext }: { row: SheetRow; today: string; onOpen: (row: SheetRow) => void; onNext: (row: SheetRow, text: string | null) => Promise<void> }) {
  return (
    <li onClick={() => onOpen(row)}
      className="flex cursor-pointer items-start gap-3 px-4 py-3 transition-colors hover:bg-[var(--bt-row-hover)] focus-within:bg-[var(--bt-row-hover)]">
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="min-w-0"><NextActionCell large value={row.next_action} due={null} today={today} onSave={(text) => onNext(row, text)} /></span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px]" style={{ color: "var(--bt-muted)" }}>
          <span>{kindLabel(row)}</span><span aria-hidden="true">·</span>
          <button type="button" title={row.title} className="min-w-0 max-w-full truncate text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--bt-text-2)]">
            {row.company ? `${row.company}: ` : ""}{row.title}
          </button>
          {row.likelihood != null && <><span aria-hidden="true">·</span><span>{row.likelihood}% chance</span></>}
          <WaitingText row={row} />
        </span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1.5">
        <span className="flex items-center gap-2">
          <DueText due={row.next_action ? row.next_due : null} today={today} />
          <DriverAvatar owner={row.owner} size={22} />
        </span>
        <ProgressChip row={row} />
      </span>
    </li>
  );
}

/** Whose move it is, from the last real message on the deal's linked threads and chats (never updated_at). */
function WaitingText({ row }: { row: SheetRow }) {
  const waiting = dealWaiting(row);
  if (!waiting) return null;
  return <><span aria-hidden="true">·</span><span data-waiting={waiting.on} style={{ color: waiting.on === "us" && waiting.days >= 1 ? "var(--bt-amber)" : undefined }}>{waitingLabel(waiting)}</span></>;
}

/** Team notes that mention this person, until they tick them. Today shows the signed-in person's, or the chosen owner's. */
function Mentions({ owner, onOpen }: { owner: DealOwner | "all"; onOpen: (listingId: string) => void }) {
  const [data, setData] = useState<{ person: string | null; me: string | null; mentions: Mention[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await request<{ person?: string | null; me?: string | null; mentions?: Mention[] }>(`/api/bulk-mentions${owner === "all" ? "" : `?for=${encodeURIComponent(owner)}`}`);
      setData({ person: r.person ?? null, me: r.me ?? null, mentions: Array.isArray(r.mentions) ? r.mentions : [] });
      setError(null);
    }
    catch (err) { setError(err instanceof Error ? err.message : "Could not load mentions."); }
  }, [owner]);
  useEffect(() => { void load(); }, [load]);
  const tick = async (id: string) => {
    try { await request(`/api/bulk-mentions/${encodeURIComponent(id)}`, { method: "POST" }); await load(); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not tick it."); }
  };
  if (!data?.mentions.length && !error) return null;
  const mine = data?.person && data.person === data.me;
  return (
    <section aria-label="Mentions" className="overflow-hidden rounded-xl border" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
      <header className="border-b px-4 py-3" style={{ borderColor: "var(--bt-divider)" }}>
        <h2 className="text-[15px] font-semibold">Mentions{data?.person && !mine ? <span className="font-normal" style={{ color: "var(--bt-muted)" }}> · for {data.person}</span> : null}</h2>
      </header>
      <ErrorText error={error} />
      <ul className="divide-y divide-[var(--bt-divider)]">
        {data?.mentions.map((m) => (
          <li key={m.id} className="flex items-start gap-3 px-4 py-3 text-[13px]">
            <button type="button" className="min-w-0 flex-1 text-left hover:underline" onClick={() => onOpen(m.listing_id)}>
              <span className="block whitespace-pre-wrap">{m.text}</span>
              <span className="block text-[12px]" style={{ color: "var(--bt-muted)" }}>{m.listing_title}{m.by ? ` · from ${m.by.split("@")[0]}` : ""}</span>
            </button>
            {mine && <button type="button" onClick={() => void tick(m.id)} className="shrink-0 rounded-lg border px-2.5 py-1 text-[12px] font-medium" style={{ borderColor: "var(--bt-border)" }}>Done</button>}
          </li>
        ))}
      </ul>
    </section>
  );
}

const REMOVE_REASONS = [["not_a_fit", "Not a fit"], ["no_longer_needed", "No longer needed"], ["duplicate", "Duplicate"], ["other", "Other"]] as const;

/** Deals in New for more than a week: open one to move it on, or remove it with a reason (closed, never deleted). */
function StuckInNew({ rows, onOpen, onChanged }: { rows: SheetRow[]; onOpen: (row: SheetRow) => void; onChanged?: () => void }) {
  const stuck = useMemo(() => stuckInNew(rows), [rows]);
  const [removing, setRemoving] = useState<string | null>(null);
  const [reason, setReason] = useState<string>("not_a_fit");
  const [why, setWhy] = useState("");
  const [error, setError] = useState<string | null>(null);
  if (!stuck.length) return null;
  const remove = async (id: string) => {
    try {
      await request(`/api/bulk-listings/${encodeURIComponent(id)}/stuck`, { method: "POST", body: JSON.stringify({ reason, why }) });
      setRemoving(null); setWhy(""); setError(null); onChanged?.();
    } catch (err) { setError(err instanceof Error ? err.message : "Could not remove it."); }
  };
  return (
    <section aria-label="Stuck in New" className="overflow-hidden rounded-xl border" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
      <header className="border-b px-4 py-3" style={{ borderColor: "var(--bt-divider)" }}>
        <h2 className="text-[15px] font-semibold">Stuck in New <span className="font-normal tabular-nums" style={{ color: "var(--bt-muted)" }}>({stuck.length})</span></h2>
        <p className="text-[12px]" style={{ color: "var(--bt-muted)" }}>In New for more than {STUCK_NEW_DAYS} days. Move each one on, or remove it with a reason.</p>
      </header>
      <ErrorText error={error} />
      <ul className="divide-y divide-[var(--bt-divider)]">
        {stuck.map(({ row, days }) => (
          <li key={row.key} className="flex flex-col gap-2 px-4 py-3 text-[13px]">
            <div className="flex items-start gap-3">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{row.company ? `${row.company}: ` : ""}{row.title}</span>
                <span className="block text-[12px]" style={{ color: "var(--bt-muted)" }}>{days} days in New{row.owner ? ` · ${row.owner}` : ""}</span>
              </span>
              <button type="button" onClick={() => onOpen(row)} className="shrink-0 rounded-lg border px-2.5 py-1 text-[12px] font-medium" style={{ borderColor: "var(--bt-border)" }}>Move on</button>
              <button type="button" onClick={() => setRemoving(removing === row.id ? null : row.id)} className="shrink-0 rounded-lg border px-2.5 py-1 text-[12px] font-medium" style={{ borderColor: "var(--bt-border)", color: "var(--bt-red)" }}>Remove</button>
            </div>
            {removing === row.id && (
              <form className="flex flex-wrap items-center gap-2" onSubmit={(event) => { event.preventDefault(); void remove(row.id); }}>
                <select aria-label="Why it is removed" value={reason} onChange={(event) => setReason(event.target.value)} className="h-8 rounded-lg border px-2 text-[12px]" style={{ borderColor: "var(--bt-border)" }}>
                  {REMOVE_REASONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
                <input aria-label="In a few words" required value={why} onChange={(event) => setWhy(event.target.value)} placeholder="In a few words" className="h-8 min-w-0 flex-1 rounded-lg border px-2 text-[12px]" style={{ borderColor: "var(--bt-border)" }} />
                <button type="submit" disabled={!why.trim()} className="h-8 rounded-lg border px-3 text-[12px] font-medium" style={{ borderColor: "var(--bt-border)" }}>Remove</button>
              </form>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** "Alex has 6 requests and 4 supply lots; 3 are deals. 9 next actions: 1 overdue, 3 due today." Same counts as the tabs. */
function summary(rows: SheetRow[], owner: DealOwner | "all", groups: { key: TodayGroupKey; rows: SheetRow[] }[]): string {
  const counts = deskCounts(rows);
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const count = (key: TodayGroupKey) => groups.find((group) => group.key === key)?.rows.length ?? 0;
  const actions = rows.filter((row) => row.next_action).length;
  const urgent = [count("overdue") && `${count("overdue")} overdue`, count("today") && `${count("today")} due today`].filter(Boolean).join(", ");
  const deals = counts.deals ? `; ${counts.deals === 1 ? "1 is a deal" : `${counts.deals} are deals`}` : "";
  return `${owner === "all" ? "The team has" : `${owner} has`} ${plural(counts.requests, "request", "requests")} and ${plural(counts.supply, "supply lot", "supply lots")}${deals}. `
    + `${plural(actions, "next action", "next actions")}${urgent ? `: ${urgent}` : ""}.`;
}

/** Today: the take target, the scorecard, the active deal warning, mentions, deals stuck in New, then every open listing's next action by
 * when it is due (overdue ones by owner), each with whose move it is from the real conversation. */
export function TodayView({ rows, owner, loading, error, today, onOpen, onNext, onOpenBoard, onOpenCompany, onChanged }: {
  rows: SheetRow[]; owner: DealOwner | "all"; loading: boolean; error: string | null; today: string;
  onOpen: (row: SheetRow) => void; onNext: (row: SheetRow, text: string | null) => Promise<void>; onOpenBoard: () => void;
  onOpenCompany?: (id: string) => void;
  /** After Today changed a deal (removed one stuck in New): reload the list. */
  onChanged?: () => void;
}) {
  const groups = useMemo(() => todayGroups(rows, today), [rows, today]);
  // Listings closed in the last 30 days are on the sheet for the Closed, Sold and Delivered columns; Today is open work only.
  const open = useMemo(() => rows.filter((row) => !row.closed), [rows]);
  const busy = loading && !rows.length;
  const crowded = useMemo(() => overLimit(open), [open]);
  const openById = useCallback((listingId: string) => {
    const row = rows.find((r) => r.id === listingId);
    if (row) onOpen(row);
  }, [rows, onOpen]);
  return (
    <BusyRegion busy={busy} label="Loading…" className="flex flex-col gap-4">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-[20px] font-semibold tracking-[-0.01em]">{new Date(`${today}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" })}</h2>
        {(busy || (!error && rows.length > 0)) && <p data-today-summary className="text-[13px]" style={{ color: "var(--bt-text-2)" }}><Sh on={busy} chars={48}>{summary(open, owner, groups)}</Sh></p>}
      </div>
      <TakeTarget rows={rows} owner={owner} loading={busy} onOpenBoard={onOpenBoard} />
      <ScorecardBlock />
      {!busy && crowded.map(({ owner: who, count }) => (
        <p key={who} role="status" data-active-warning className="rounded-xl border px-4 py-3 text-[13px]" style={{ color: "var(--bt-amber)", background: "var(--bt-amber-bg)", borderColor: "var(--bt-amber-border)" }}>
          {who === "No owner" ? `${count} active deals have no owner` : `${who} has ${count} active deals`}. More than {ACTIVE_DEAL_LIMIT} is more than one person can work well: park some, or hand them on.
        </p>
      ))}
      <Mentions owner={owner} onOpen={openById} />
      {!busy && <StuckInNew rows={open} onOpen={onOpen} onChanged={onChanged} />}
      <DossiersToReview onOpenCompany={onOpenCompany} />
      <ErrorText error={error} />
      <section aria-label="Next actions" className="overflow-hidden rounded-xl border" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
        <header className="flex items-baseline justify-between gap-2 border-b px-4 py-3" style={{ borderColor: "var(--bt-divider)" }}>
          <h2 className="text-[15px] font-semibold">Next actions</h2>
        </header>
        {busy ? (
          <ul className="divide-y divide-[var(--bt-divider)]">
            {Array.from({ length: 5 }, (_, index) => <li key={index} className="flex flex-col gap-1.5 px-4 py-3 text-[13px]"><Sh on chars={30 + (index % 3) * 8} /><span className="text-[12px]"><Sh on chars={22} /></span></li>)}
          </ul>
        ) : !rows.length ? (
          <p className="px-4 py-10 text-center text-[13px]" style={{ color: "var(--bt-muted)" }}>{error ? "The list could not load." : "Nothing open right now."}</p>
        ) : groups.filter((group) => group.rows.length).map((group) => (
          <section key={group.key} aria-label={group.label} data-group={group.key}>
            <h3 className="border-b px-4 py-1.5 text-[12px] font-semibold" style={{ background: "var(--bt-table-head)", borderColor: "var(--bt-divider)", color: GROUP_TONE[group.key] ?? "var(--bt-text-2)" }}>
              {group.label} <span className="font-normal tabular-nums" style={{ color: "var(--bt-muted)" }}>({group.rows.length})</span>
            </h3>
            {group.key === "overdue" && owner === "all" ? overdueByOwner(group.rows).map(({ owner: who, rows: list }) => (
              <section key={who} aria-label={`Overdue: ${who}`} data-overdue-owner={who}>
                <h4 className="border-b px-4 py-1 text-[12px] font-medium" style={{ borderColor: "var(--bt-divider)", color: "var(--bt-text-2)" }}>{who} <span className="font-normal tabular-nums" style={{ color: "var(--bt-muted)" }}>({list.length})</span></h4>
                <ul className="divide-y divide-[var(--bt-divider)] border-b" style={{ borderColor: "var(--bt-divider)" }}>
                  {list.map((row) => <ActionRow key={row.key} row={row} today={today} onOpen={onOpen} onNext={onNext} />)}
                </ul>
              </section>
            )) : (
              <ul className="divide-y divide-[var(--bt-divider)] border-b" style={{ borderColor: "var(--bt-divider)" }}>
                {group.rows.map((row) => <ActionRow key={row.key} row={row} today={today} onOpen={onOpen} onNext={onNext} />)}
              </ul>
            )}
          </section>
        ))}
      </section>
    </BusyRegion>
  );
}
