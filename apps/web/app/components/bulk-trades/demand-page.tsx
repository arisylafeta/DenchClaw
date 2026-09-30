"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BASES,
  CHECK_LABEL,
  CLOSED_REASONS,
  CLOSED_REASON_LABEL,
  CURRENCIES,
  PRICE_UNITS,
  SPEC_LABELS,
  SPEC_LISTS,
  SPEC_NUMBERS,
  SPEC_NUMBER_KEYS,
  VOLUME_UNITS,
  checkReason,
  priceLabel,
  specLines,
  volumeLabel,
  waitingLabel,
  type Basis,
  type ClosedReason,
  type Demand,
  type DemandInput,
  type DemandKind,
  type Spec,
  type SpecListKey,
} from "@/lib/bulk-demand";
import { shortDate, ukTime, type Proposal } from "@/lib/bulk-trade-details";
import { CrmSearch } from "./buyer-dialogs";
import { DemandBadge, TierBadge } from "./demand-badge";
import { ProposalRow } from "./proposal-row";
import {
  Card,
  ErrorText,
  FormField,
  Modal,
  buttonClass,
  buttonStyle,
  darkButtonClass,
  darkButtonStyle,
  request,
  tradeUrl,
  useForm,
} from "./trade-ui";

/** The latest demand-matching pass. */
type MatchRun = { at: string; status: "running" | "ok" | "failed" };

type Filter = "requests" | "standing" | "check" | "closed";

type Props = {
  today: string;
  onOpenTrade: (lotId: string) => void;
};

const COLUMNS = "grid-cols-[minmax(160px,1fr)_minmax(260px,2.2fr)_130px_100px_120px_minmax(140px,1fr)]";

/**
 * Who wants what (bulk only, 2+ units): requests (one-off, by a date) and standing buy-boxes (ongoing, estimated,
 * stated or agreed), which live trades fit, and new demand from the inbox.
 */
export function DemandPage({ today, onOpenTrade }: Props) {
  const [demand, setDemand] = useState<Demand[]>([]);
  const [possible, setPossible] = useState<Proposal[]>([]);
  const [matched, setMatched] = useState<MatchRun | null>(null);
  const [chosen, setFilter] = useState<Filter | null>(null);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Demand | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await request<{ demand: Demand[]; possible: Proposal[]; matched?: MatchRun | null }>("/api/bulk-trades/demand");
      setDemand(data.demand);
      setPossible(data.possible);
      setMatched(data.matched ?? null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load demand.");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const open = demand.filter((row) => row.status === "open");
  const toCheck = open.filter((row) => checkReason(row, today));
  const requests = open.filter((row) => row.kind === "request");
  const standing = open.filter((row) => row.kind === "standing");
  // Requests first while there are any: they have dates.
  const filter = chosen ?? (requests.length ? "requests" : "standing");
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const rows = filter === "closed" ? demand.filter((row) => row.status === "closed")
      : filter === "check" ? toCheck
        : filter === "requests" ? requests
          // Tier A buyers first, grouped by buyer; the server already orders each buyer's rows agreed, stated, estimated.
          : standing.toSorted((a, b) => tierOrder(a.tier) - tierOrder(b.tier) || a.buyer.localeCompare(b.buyer));
    return needle ? rows.filter((row) => `${row.buyer} ${row.contact ?? ""} ${row.wants} ${specLines(row.spec).join(" ")}`
      .toLowerCase().includes(needle)) : rows;
  }, [demand, filter, query, toCheck, requests, standing]);
  const selected = demand.find((row) => row.id === selectedId) ?? null;

  const segment = (value: Filter, label: string) => (
    <button type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}
      className="h-8 px-3 text-[13px] font-medium"
      style={filter === value ? { background: "var(--bt-badge)", color: "var(--bt-on-badge)" } : { background: "var(--bt-surface)", color: "var(--bt-text)" }}>
      {label}
    </button>
  );

  return (
    <div className="flex min-h-0 gap-6">
      <div className="flex min-w-0 flex-1 flex-col gap-5">
        <ErrorText error={error} />
        {!!possible.length && (
          <Card label="Possible demand">
            <header className="flex items-center gap-2.5 border-b px-5 py-3" style={{ borderColor: "var(--bt-divider)" }}>
              <span className="rounded-none px-[7px] py-0.5 text-[11px] font-semibold uppercase" style={{ background: "var(--bt-badge)", color: "var(--bt-on-badge)" }}>New</span>
              <h2 className="text-[15px] font-semibold">Possible demand from your inbox</h2>
              <span className="text-[13px]" style={{ color: "var(--bt-muted)" }}>{possible.length} found</span>
            </header>
            {possible.map((proposal) => (
              <div key={proposal.id} className="border-b last:border-b-0" style={{ borderColor: "var(--bt-divider)" }}>
                <ProposalRow
                  proposal={proposal}
                  acceptLabel={proposal.target ? "Update demand" : "Add demand"}
                  onDecided={(decided, action) => {
                    setPossible((current) => current.filter((candidate) => candidate.id !== decided.id));
                    if (action === "accept") void load();
                  }}
                />
              </div>
            ))}
          </Card>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <div role="group" aria-label="Filter" className="flex border" style={{ borderColor: "var(--bt-border)" }}>
            {segment("requests", `Requests ${requests.length}`)}
            {segment("standing", `Standing ${standing.length}`)}
            {segment("check", `To check ${toCheck.length}`)}
            {segment("closed", "Closed")}
          </div>
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search demand"
            placeholder="Search buyers or wants" className="h-8 w-full max-w-[340px] rounded-none border px-2.5 text-[13px]"
            style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)", color: "var(--bt-text)" }} />
          <span className="flex-1" />
          <span className="text-[13px]" style={{ color: "var(--bt-muted)" }}>Bulk only, 2+ units</span>
          {matched && (
            <span className="text-[13px]" style={{ color: matched.status === "failed" ? "var(--bt-red)" : "var(--bt-muted)" }}>
              {matched.status === "failed" ? "Matching failed" : matched.status === "running" ? "Matching now" : "Matched"} {ukTime(matched.at)}
            </span>
          )}
          <button type="button" onClick={() => setEditing("new")} className="h-9 rounded-none bg-[var(--bt-accent)] px-3.5 text-sm font-semibold hover:bg-[var(--bt-accent-hover)]"
            style={{ color: "var(--bt-on-accent)" }}>
            Add demand
          </button>
        </div>

        <Card label="Demand" className="overflow-x-auto">
          <div className="min-w-[900px]">
            <div className={`bt-label grid ${COLUMNS} gap-3.5 border-b px-5 py-2.5`} style={{ background: "var(--bt-table-head)", borderColor: "var(--bt-divider)" }}>
              <span>Buyer</span><span>Wants</span><span>Volume</span><span>Where</span>
              <span>{filter === "requests" ? "Needed by" : "Confirmed"}</span><span>Fits</span>
            </div>
            {shown.map((row) => {
              const check = checkReason(row, today);
              const summary = [...specLines(row.spec).slice(0, 3), priceLabel(row) && `max ${priceLabel(row)}`].filter(Boolean).join(" · ");
              return (
                <button key={row.id} type="button" onClick={() => setSelectedId(row.id)} aria-pressed={row.id === selectedId}
                  className={`grid w-full ${COLUMNS} items-center gap-3.5 border-b px-5 py-3 text-left last:border-b-0 hover:bg-[var(--bt-row-hover)]`}
                  style={{ borderColor: "var(--bt-divider)", color: check || row.status === "closed" ? "var(--bt-muted)" : "var(--bt-text)",
                    background: row.id === selectedId ? "var(--bt-row-hover)" : undefined }}>
                  <div className="flex min-w-0 flex-col items-start gap-1">
                    <div className="max-w-full truncate text-sm font-semibold">{row.buyer}</div>
                    {row.contact && <div className="max-w-full truncate text-xs" style={{ color: "var(--bt-muted)" }}>{row.contact}</div>}
                    <span className="flex flex-wrap gap-1">
                      <TierBadge tier={row.tier} />
                      <DemandBadge kind={row.kind} basis={row.basis} />
                      {row.waiting && (
                        <span className="rounded-none border px-1.5 py-px text-xs font-medium" title={row.waiting.subject ?? undefined}
                          style={{ background: "var(--bt-amber-bg)", color: "var(--bt-amber)", borderColor: "var(--bt-amber-border)" }}>
                          {waitingLabel(row.waiting.since)}
                        </span>
                      )}
                    </span>
                  </div>
                  <span className="flex flex-col gap-0.5 text-[13px] leading-snug">
                    {row.wants}
                    {summary && <span className="text-xs" style={{ color: "var(--bt-muted)" }}>{summary}</span>}
                  </span>
                  <span className="bt-mono text-[13px]">{volumeLabel(row) ?? ""}</span>
                  <span className="text-[13px]">{row.location ?? ""}</span>
                  <span className="flex flex-col items-start gap-1 text-[13px]">
                    {row.kind === "request"
                      ? (row.needed_by ? shortDate(row.needed_by) : "No date")
                      : (row.confirmed_on ? shortDate(row.confirmed_on) : "Never")}
                    {check && (
                      <span className="rounded-none border px-1.5 py-px text-xs font-medium"
                        style={{ background: "var(--bt-amber-bg)", color: "var(--bt-amber)", borderColor: "var(--bt-amber-border)" }}>{CHECK_LABEL[check]}</span>
                    )}
                    {row.status === "closed" && row.closed_reason && <span className="text-xs">{CLOSED_REASON_LABEL[row.closed_reason]}</span>}
                  </span>
                  <span className="text-[13px]" style={{ color: row.fits.length ? "var(--bt-link)" : "var(--bt-muted)" }}>
                    {row.fits.length ? row.fits.map((fit) => fit.title).join(" · ") : "—"}
                  </span>
                </button>
              );
            })}
            {!shown.length && <p className="px-5 py-8 text-center text-sm" style={{ color: "var(--bt-muted)" }}>Nothing here.</p>}
          </div>
        </Card>
      </div>

      {selected && (
        <DemandPanel key={selected.id} demand={selected} today={today} onClose={() => setSelectedId(null)} onChanged={load}
          onEdit={() => setEditing(selected)} onOpenTrade={onOpenTrade} />
      )}
      {editing && (
        <DemandDialog demand={editing === "new" ? null : editing} onClose={() => setEditing(null)}
          onSaved={(saved) => { setEditing(null); setSelectedId(saved.id); void load(); }} />
      )}
    </div>
  );
}

function DemandPanel({ demand, today, onClose, onChanged, onEdit, onOpenTrade }: {
  demand: Demand;
  today: string;
  onClose: () => void;
  onChanged: () => void;
  onEdit: () => void;
  onOpenTrade: (lotId: string) => void;
}) {
  const [closing, setClosing] = useState(false);
  const [reason, setReason] = useState<ClosedReason>("no_longer_needed");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }
  const patch = (body: object) => request(`/api/bulk-trades/demand/${encodeURIComponent(demand.id)}`, { method: "PATCH", body: JSON.stringify(body) });

  return (
    <aside aria-label="Demand detail" className="flex w-[380px] shrink-0 flex-col gap-4 self-start rounded-none border p-5"
      style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="bt-label">{demand.kind === "request" ? "Request" : "Standing buy-box"}</span>
            <DemandBadge kind={demand.kind} basis={demand.basis} />
          </div>
          <h2 className="mt-1 text-lg font-semibold">{demand.buyer}</h2>
          {(demand.contact || demand.email) && (
            <div className="text-[13px]" style={{ color: "var(--bt-muted)" }}>{[demand.contact, demand.email].filter(Boolean).join(" · ")}</div>
          )}
        </div>
        <button type="button" onClick={onClose} className="text-sm" style={{ color: "var(--bt-muted)" }}>Close</button>
      </div>
      {demand.waiting && (
        <p className="rounded-none border px-3 py-2 text-[13px]" style={{ background: "var(--bt-amber-bg)", color: "var(--bt-amber)", borderColor: "var(--bt-amber-border)" }}>
          {waitingLabel(demand.waiting.since)} on your reply{demand.waiting.who ? ` to ${demand.waiting.who}` : ""}
          {demand.waiting.subject ? `: “${demand.waiting.subject}”` : ""}
        </p>
      )}
      <p className="text-[15px] leading-snug">{demand.wants}</p>
      <dl className="grid grid-cols-[110px_1fr] gap-y-1.5 text-sm">
        <dt style={{ color: "var(--bt-muted)" }}>Volume</dt><dd>{volumeLabel(demand) ?? "—"}</dd>
        {demand.quantity && demand.volume != null && (<>
          <dt style={{ color: "var(--bt-muted)" }}>In their words</dt><dd>{demand.quantity}</dd>
        </>)}
        <dt style={{ color: "var(--bt-muted)" }}>Max price</dt><dd>{priceLabel(demand) ?? "—"}</dd>
        <dt style={{ color: "var(--bt-muted)" }}>Where</dt><dd>{demand.location ?? "—"}</dd>
        {demand.kind === "request" && (<>
          <dt style={{ color: "var(--bt-muted)" }}>Needed by</dt><dd>{demand.needed_by ? shortDate(demand.needed_by) : "—"}</dd>
        </>)}
        <dt style={{ color: "var(--bt-muted)" }}>Confirmed</dt>
        <dd>{demand.confirmed_on ? shortDate(demand.confirmed_on) : "Never"}
          {checkReason(demand, today) ? ` · ${CHECK_LABEL[checkReason(demand, today)!].toLowerCase()}` : ""}</dd>
        {demand.source_label && (<>
          <dt style={{ color: "var(--bt-muted)" }}>Source</dt>
          <dd>{demand.source_url
            ? <a href={demand.source_url} target="_blank" rel="noreferrer" className="hover:underline" style={{ color: "var(--bt-link)" }}>{demand.source_label}</a>
            : demand.source_label}{demand.observed_on ? `, ${shortDate(demand.observed_on)}` : ""}</dd>
        </>)}
      </dl>
      {!!specLines(demand.spec).length && (
        <ul aria-label="Spec" className="flex flex-col gap-1 border-t pt-3 text-[13px]" style={{ borderColor: "var(--bt-divider)" }}>
          {specLines(demand.spec).map((line) => <li key={line}>{line}</li>)}
        </ul>
      )}
      {!!demand.trades.length && (
        <div className="flex flex-col gap-1.5 border-t pt-3" style={{ borderColor: "var(--bt-divider)" }}>
          <h3 className="text-sm font-semibold">Offered on</h3>
          {demand.trades.map((trade) => (
            <button key={trade.lot_id} type="button" onClick={() => onOpenTrade(trade.lot_id)}
              className="flex items-center gap-2 text-left text-[13px] hover:underline">
              <span className="flex-1">{trade.title}</span>
              <span style={{ color: trade.status === "Won" ? "var(--bt-green)" : "var(--bt-muted)" }}>{trade.status}</span>
            </button>
          ))}
        </div>
      )}
      {demand.note && <p className="text-[13px]" style={{ color: "var(--bt-text-2)" }}>{demand.note}</p>}
      {demand.source_quote && (
        <p className="border-t pt-3 text-[13px]" style={{ borderColor: "var(--bt-divider)", color: "var(--bt-text-2)" }}>“{demand.source_quote}”</p>
      )}
      <div className="flex flex-col gap-2.5 border-t pt-3" style={{ borderColor: "var(--bt-divider)" }}>
        <h3 className="text-sm font-semibold">Fits these trades</h3>
        {!demand.fits.length && <p className="text-[13px]" style={{ color: "var(--bt-muted)" }}>No live trade fits yet. Matching runs with each inbox check.</p>}
        {demand.fits.map((fit) => (
          <div key={fit.lot_id} className="flex flex-col gap-1.5 rounded-none border px-3 py-2.5" style={{ borderColor: "var(--bt-border)" }}>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => onOpenTrade(fit.lot_id)} className="flex-1 text-left text-sm font-semibold hover:underline">{fit.title}</button>
              <span className="rounded-none border px-1.5 py-px text-xs font-medium"
                style={fit.strength === "strong"
                  ? { background: "var(--bt-green-bg)", color: "var(--bt-green)", borderColor: "var(--bt-green-border)" }
                  : { background: "var(--bt-divider)", color: "var(--bt-text-2)", borderColor: "var(--bt-grey-border)" }}>
                {fit.strength === "strong" ? "Strong" : "Partial"}
              </span>
            </div>
            <span className="text-[13px]" style={{ color: "var(--bt-text-2)" }}>{fit.reason}</span>
            {fit.buyer_id
              ? <span className="text-xs" style={{ color: "var(--bt-muted)" }}>On this trade’s buyers</span>
              : (
                <button type="button" disabled={busy} className={`${buttonClass} h-8 self-start`} style={buttonStyle}
                  onClick={() => run(() => request(tradeUrl(fit.lot_id, `/suggested/${encodeURIComponent(demand.id)}`), { method: "POST" }))}>
                  Add as buyer on this trade
                </button>
              )}
          </div>
        ))}
      </div>
      <ErrorText error={error} />
      {closing ? (
        <div className="flex flex-wrap items-center gap-2 border-t pt-3" style={{ borderColor: "var(--bt-divider)" }}>
          <label className="sr-only" htmlFor={`close-${demand.id}`}>Why</label>
          <select id={`close-${demand.id}`} value={reason} onChange={(event) => setReason(event.target.value as ClosedReason)}
            className="h-9 rounded-none border px-2 text-sm" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)", color: "var(--bt-text)" }}>
            {CLOSED_REASONS.map((value) => <option key={value} value={value}>{CLOSED_REASON_LABEL[value]}</option>)}
          </select>
          <button type="button" disabled={busy} className={`${darkButtonClass} h-9`} style={darkButtonStyle}
            onClick={() => run(async () => { await patch({ action: "close", reason }); setClosing(false); })}>Close demand</button>
          <button type="button" onClick={() => setClosing(false)} className={`${buttonClass} h-9`} style={buttonStyle}>Cancel</button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2 border-t pt-3" style={{ borderColor: "var(--bt-divider)" }}>
          <button type="button" disabled={busy} className={`${darkButtonClass} h-9`} style={darkButtonStyle}
            onClick={() => run(() => patch({ action: "confirm" }))}>
            {demand.status === "closed" ? "Reopen" : demand.basis === "estimated" ? "Research still holds" : "Still wanted"}
          </button>
          <button type="button" onClick={onEdit} className={`${buttonClass} h-9`} style={buttonStyle}>Edit</button>
          {demand.status === "open" && demand.kind === "standing" && BASES.filter((basis) => basis !== demand.basis && basis !== "estimated").map((basis) => (
            <button key={basis} type="button" disabled={busy} className={`${buttonClass} h-9`} style={buttonStyle}
              onClick={() => run(() => patch({ action: "basis", basis }))}>
              {basis === "agreed" ? "Agreed with buyer" : "Buyer stated it"}
            </button>
          ))}
          {demand.status === "open" && demand.kind === "request" && (
            <button type="button" disabled={busy} className={`${buttonClass} h-9`} style={buttonStyle}
              onClick={() => run(() => patch({ action: "make_standing" }))}>Make standing</button>
          )}
          {demand.status === "open" && <button type="button" onClick={() => setClosing(true)} className={`${buttonClass} h-9`} style={buttonStyle}>Close…</button>}
        </div>
      )}
    </aside>
  );
}

const tierOrder = (tier: string | null) => ({ A: 0, B: 1, C: 2 } as Record<string, number>)[tier ?? ""] ?? 3;

const MAIN_LISTS: SpecListKey[] = ["chemistries", "formats", "conditions", "origins"];
const MORE_LISTS: SpecListKey[] = ["cell_formats", "makes", "cell_makers", "system_brands", "evidence", "excludes"];

/** Toggle chips for one spec list. */
function SpecChips({ name, selected, onChange }: { name: SpecListKey; selected: string[]; onChange: (values: string[]) => void }) {
  return (
    <div role="group" aria-label={SPEC_LABELS[name]} className="flex flex-col gap-1">
      <span className="text-xs font-medium" style={{ color: "var(--bt-muted)" }}>{SPEC_LABELS[name]}</span>
      <div className="flex flex-wrap gap-1.5">
        {SPEC_LISTS[name].map((value) => {
          const on = selected.includes(value);
          return (
            <button key={value} type="button" aria-pressed={on}
              onClick={() => onChange(on ? selected.filter((item) => item !== value) : [...selected, value])}
              className="h-7 rounded-none border px-2 text-xs"
              style={on ? { background: "var(--bt-badge)", color: "var(--bt-on-badge)", borderColor: "var(--bt-badge)" }
                : { background: "var(--bt-surface)", color: "var(--bt-text)", borderColor: "var(--bt-border)" }}>
              {value}
            </button>
          );
        })}
      </div>
    </div>
  );
}

const numberText = (value: number | null | undefined) => (value == null ? "" : String(value));
const toNumber = (value: string) => (value.trim() === "" ? null : Number(value));

function DemandDialog({ demand, onClose, onSaved }: {
  demand: Demand | null;
  onClose: () => void;
  onSaved: (demand: Demand) => void;
}) {
  const [paste, setPaste] = useState("");
  const [filling, setFilling] = useState(false);
  const [link, setLink] = useState<{ person_id?: string | null; company_id?: string | null }>({});
  const [lists, setLists] = useState<Partial<Record<SpecListKey, string[]>>>(() =>
    Object.fromEntries(Object.entries(demand?.spec ?? {}).filter(([key]) => key in SPEC_LISTS)));
  const form = useForm({
    kind: demand?.kind ?? "request", basis: demand?.basis ?? "stated",
    buyer: demand?.buyer ?? "", contact: demand?.contact ?? "", email: demand?.email ?? "", wants: demand?.wants ?? "",
    quantity: demand?.quantity ?? "", location: demand?.location ?? "", note: demand?.note ?? "",
    needed_by: demand?.needed_by ?? "", volume: numberText(demand?.volume), volume_unit: demand?.volume_unit ?? "packs",
    max_price: numberText(demand?.max_price), price_currency: demand?.price_currency ?? "EUR", price_unit: demand?.price_unit ?? "kWh",
    kwh_min: numberText(demand?.spec.kwh_min), kwh_max: numberText(demand?.spec.kwh_max), min_soh: numberText(demand?.spec.min_soh),
    mixed_ok: demand?.spec.mixed_ok === undefined ? "" : demand.spec.mixed_ok ? "yes" : "no",
  }, async (draft) => {
    const request_ = draft.kind === "request";
    const spec: Spec = { ...lists };
    for (const key of SPEC_NUMBER_KEYS) {
      const value = toNumber(draft[key]);
      if (value !== null) spec[key] = value;
    }
    if (draft.mixed_ok) spec.mixed_ok = draft.mixed_ok === "yes";
    const volume = toNumber(draft.volume);
    const maxPrice = toNumber(draft.max_price);
    const body: Record<string, unknown> = {
      ...link,
      kind: draft.kind as DemandKind,
      ...(request_ ? { needed_by: draft.needed_by || null } : { basis: draft.basis as Basis }),
      volume, volume_unit: volume === null ? null : draft.volume_unit,
      max_price: maxPrice, price_currency: maxPrice === null ? null : draft.price_currency, price_unit: maxPrice === null ? null : draft.price_unit,
      spec,
    };
    for (const key of ["buyer", "contact", "email", "wants", "quantity", "location", "note"] as const) body[key] = draft[key].trim() || null;
    const { demand: saved } = await request<{ demand: Demand }>(
      demand ? `/api/bulk-trades/demand/${encodeURIComponent(demand.id)}` : "/api/bulk-trades/demand",
      { method: demand ? "PATCH" : "POST", body: JSON.stringify(body) },
    );
    onSaved(saved);
  });

  const fill = () => form.run(async () => {
    setFilling(true);
    try {
      const { fields } = await request<{ fields: DemandInput }>("/api/bulk-trades/demand/fill", { method: "POST", body: JSON.stringify({ text: paste }) });
      const { spec, volume, max_price: maxPrice, ...rest } = fields;
      const text = Object.fromEntries(Object.entries(rest).filter(([, value]) => typeof value === "string" && value));
      form.setDraft((current) => ({
        ...current, ...text,
        ...(volume != null ? { volume: String(volume) } : {}),
        ...(maxPrice != null ? { max_price: String(maxPrice) } : {}),
        ...Object.fromEntries(SPEC_NUMBER_KEYS.filter((key) => spec?.[key] !== undefined).map((key) => [key, String(spec![key])])),
        ...(spec?.mixed_ok !== undefined ? { mixed_ok: spec.mixed_ok ? "yes" : "no" } : {}),
      }));
      if (spec) setLists((current) => ({ ...current, ...Object.fromEntries(Object.entries(spec).filter(([key]) => key in SPEC_LISTS)) }));
    } finally {
      setFilling(false);
    }
  });

  const isRequest = form.draft.kind === "request";
  const setList = (key: SpecListKey) => (values: string[]) => setLists((current) => ({ ...current, [key]: values }));

  return (
    <Modal title={demand ? "Edit demand" : "Add demand"} onClose={onClose} onSubmit={form.submit} wide
      footer={<>
        <button type="button" onClick={onClose} className={`${buttonClass} h-9`} style={buttonStyle}>Cancel</button>
        <button type="submit" disabled={form.saving} className={`${darkButtonClass} h-9`} style={darkButtonStyle}>{demand ? "Save" : "Add demand"}</button>
      </>}>
      {!demand && (
        <FormField label="Paste from an email (optional)">
          <textarea value={paste} onChange={(event) => setPaste(event.target.value)} rows={3}
            placeholder="We are looking for 100+ NMC packs, 30–70 kWh, for storage builds in India…"
            className="w-full rounded-none border px-2.5 py-2 text-sm" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)", color: "var(--bt-text)" }} />
          <button type="button" disabled={filling || paste.trim().length < 10} onClick={fill} className={`${buttonClass} h-8 self-start`} style={buttonStyle}>
            {filling ? "Reading…" : "Fill the form"}
          </button>
        </FormField>
      )}
      <div role="group" aria-label="Kind" className="flex self-start border" style={{ borderColor: "var(--bt-border)" }}>
        {(["request", "standing"] as const).map((kind) => (
          <button key={kind} type="button" aria-pressed={form.draft.kind === kind}
            onClick={() => form.setDraft((current) => ({ ...current, kind }))}
            className="h-8 px-3 text-[13px] font-medium"
            style={form.draft.kind === kind ? { background: "var(--bt-badge)", color: "var(--bt-on-badge)" } : { background: "var(--bt-surface)", color: "var(--bt-text)" }}>
            {kind === "request" ? "Request: one-off, by a date" : "Standing: ongoing buy-box"}
          </button>
        ))}
      </div>
      <CrmSearch
        onCompany={(company) => { form.setDraft((current) => ({ ...current, buyer: company.name })); setLink({ company_id: company.id }); }}
        onPerson={(person) => {
          form.setDraft((current) => ({ ...current, buyer: person.company ?? person.name, contact: person.name, email: person.email ?? current.email }));
          setLink({ person_id: person.id });
        }}
      />
      <FormField label="Buyer">{form.input("buyer", { required: true })}</FormField>
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Contact">{form.input("contact")}</FormField>
        <FormField label="Email">{form.input("email", { type: "email" })}</FormField>
      </div>
      <FormField label="Wants">{form.input("wants", { required: true, placeholder: "One line, the way the buyer would say it" })}</FormField>
      <div className="grid grid-cols-3 gap-3">
        {isRequest
          ? <FormField label="Needed by">{form.input("needed_by", { type: "date" })}</FormField>
          : <FormField label="Basis">{form.select("basis", BASES, { estimated: "Estimated (our research)", stated: "Stated (buyer said)", agreed: "Agreed (confirmed)" })}</FormField>}
        <FormField label={isRequest ? "Volume in total" : "Volume a month"}>{form.input("volume", { type: "number", min: 0, step: "any" })}</FormField>
        <FormField label="Unit">{form.select("volume_unit", VOLUME_UNITS)}</FormField>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <FormField label="Max price">{form.input("max_price", { type: "number", min: 0, step: "any" })}</FormField>
        <FormField label="Currency">{form.select("price_currency", CURRENCIES)}</FormField>
        <FormField label="Per">{form.select("price_unit", PRICE_UNITS)}</FormField>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Quantity in their words">{form.input("quantity", { placeholder: "e.g. 100+ packs, 7–8 a month" })}</FormField>
        <FormField label="Where">{form.input("location")}</FormField>
      </div>
      <fieldset className="flex flex-col gap-3 border-t pt-3" style={{ borderColor: "var(--bt-divider)" }}>
        <legend className="text-sm font-semibold">Spec</legend>
        {MAIN_LISTS.map((key) => <SpecChips key={key} name={key} selected={lists[key] ?? []} onChange={setList(key)} />)}
        <div className="grid grid-cols-4 gap-3">
          {SPEC_NUMBER_KEYS.map((key) => (
            <FormField key={key} label={SPEC_NUMBERS[key].label}>{form.input(key, { type: "number", min: SPEC_NUMBERS[key].min, max: SPEC_NUMBERS[key].max, step: "any" })}</FormField>
          ))}
          <FormField label="Mixed batches">{form.select("mixed_ok", ["", "yes", "no"], { "": "Not known", yes: "OK", no: "One make and model" })}</FormField>
        </div>
        <details>
          <summary className="cursor-pointer text-[13px] font-medium">Makes, cell makers, system brands, evidence, won&apos;t take</summary>
          <div className="mt-3 flex flex-col gap-3">
            {MORE_LISTS.map((key) => <SpecChips key={key} name={key} selected={lists[key] ?? []} onChange={setList(key)} />)}
          </div>
        </details>
      </fieldset>
      <FormField label="Note">{form.input("note")}</FormField>
      <p className="text-xs" style={{ color: "var(--bt-muted)" }}>Bulk only: 2 or more units.</p>
      <ErrorText error={form.error} />
    </Modal>
  );
}
