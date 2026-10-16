"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatFee, REPUTATION_LABEL, scoreDemand } from "@/lib/bulk-demand-score";
import {
  BASES,
  CLOSED_REASONS,
  CLOSED_REASON_LABEL,
  CURRENCIES,
  PRICE_UNITS,
  SPEC_LABELS,
  SPEC_LISTS,
  SPEC_NUMBERS,
  SPEC_NUMBER_KEYS,
  VOLUME_UNITS,
  priceLabel,
  specLines,
  volumeLabel,
  type ClosedReason,
  type Demand,
  type DemandInput,
  type Spec,
  type SpecListKey,
} from "@/lib/bulk-demand";
import { shortDate } from "@/lib/bulk-trade-details";
import type { DemandActivity as Activity } from "@/lib/crm-postgres/bulk-demand-activity";
import tableStyles from "../ui/data-table.module.css";
import { TableCellContent } from "../ui/table-cell";
import { CrmSearch } from "./buyer-dialogs";
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
  useForm,
} from "./trade-ui";


type Filter = "open" | "qualifying" | "closed";

type Props = {
  today: string;
  onOpenTrade: (lotId: string) => void;
  onOpenSupply?: (id: string) => void;
  initialDemandId?: string | null;
};

const COLUMNS = "grid-cols-[52px_minmax(120px,1fr)_minmax(180px,2fr)_100px]";
export function DemandPage({ today, onOpenTrade, onOpenSupply, initialDemandId }: Props) {
  const [demand, setDemand] = useState<Demand[]>([]);
  const [filter, setFilter] = useState<Filter>("open");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(initialDemandId ?? null);
  const [editing, setEditing] = useState<Demand | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const data = await request<{ demand: Demand[] }>("/api/bulk-trades/demand");
      setDemand(data.demand);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load demand.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const open = demand.filter((row) => row.status === "open");
  const qualifying = demand.filter((row) => row.status === "qualifying");
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return demand.filter((row) => row.status === filter)
      .filter((row) => !needle || `${row.buyer} ${row.contact ?? ""} ${row.wants} ${row.product_family ?? ""} ${specLines(row.spec).join(" ")}`.toLowerCase().includes(needle))
      .toSorted((a, b) => (ranking(b, today).score ?? -1) - (ranking(a, today).score ?? -1) || a.buyer.localeCompare(b.buyer));
  }, [demand, filter, query, today]);
  const selected = demand.find((row) => row.id === selectedId) ?? null;

  const segment = (value: Filter, label: string) => (
    <button type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}
      className="h-8 px-3 text-xs font-medium"
      style={filter === value ? { background: "var(--bt-badge)", color: "var(--bt-on-badge)" } : { background: "var(--bt-surface)", color: "var(--bt-text)" }}>
      {label}
    </button>
  );

  return (
    <div className="flex min-h-0 flex-col gap-5 xl:flex-row">
      <div className="flex min-w-0 flex-1 flex-col gap-5">
        <ErrorText error={error} />
        <div data-table-part="toolbar" className={`bulk-trades ${tableStyles.surface} flex flex-wrap items-center gap-3 border`}>
          <div role="group" aria-label="Filter" className="flex border" style={{ borderColor: "var(--bt-border)" }}>
            {segment("open", `Demand ${open.length}`)}
            {segment("qualifying", `Qualifying ${qualifying.length}`)}
            {segment("closed", `Closed ${demand.filter((row) => row.status === "closed").length}`)}
          </div>
          <input data-table-part="search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search demand"
            placeholder="Search buyers or wants" className="h-8 w-full max-w-[340px] rounded-none border px-2.5 text-xs"
            style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)", color: "var(--bt-text)" }} />
          <span className="flex-1" />
          <button type="button" onClick={() => setEditing("new")} className="h-8 rounded-none bg-[var(--bt-accent)] px-3.5 text-xs font-semibold hover:bg-[var(--bt-accent-hover)]"
            style={{ color: "var(--bt-on-accent)" }}>
            Add demand
          </button>
        </div>

        <Card label="Demand" className={`bulk-trades ${tableStyles.surface} overflow-x-auto`}>
          <div className="min-w-[760px]">
            <div data-table-part="grid-header" className={`grid ${COLUMNS} gap-3.5 border-b px-3 py-2 font-medium`} style={{ background: "var(--bt-table-head)", borderColor: "var(--bt-divider)" }}>
              <span>Score</span><span>Buyer</span><span>Ask</span><span>Activity</span>
            </div>
            {shown.map((row) => {
              const scored = ranking(row, today);
              return (
                <div key={row.id} data-table-part="grid-row" role="button" tabIndex={0} onClick={() => setSelectedId(row.id)} aria-pressed={row.id === selectedId}
                  onKeyDown={(event) => {
                    if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
                      event.preventDefault();
                      setSelectedId(row.id);
                    }
                  }}
                  className={`grid w-full ${COLUMNS} items-center gap-3.5 border-b px-3 py-2 text-left text-xs last:border-b-0 hover:bg-[var(--bt-row-hover)]`}
                  style={{ borderColor: "var(--bt-divider)", color: row.status === "closed" ? "var(--bt-muted)" : "var(--bt-text)",
                    background: row.id === selectedId ? "var(--bt-row-hover)" : undefined }}>
                  <TableCellContent>{row.status === "qualifying" ? <span style={{ color: "var(--bt-amber)" }}>?</span> : <DemandScore demand={row} today={today} />}</TableCellContent>
                  <TableCellContent><span className="truncate font-semibold">{row.buyer}</span></TableCellContent>
                  <TableCellContent><div className="min-w-0">
                    <div className="truncate" title={row.wants}>{row.wants}</div>
                    <div className="truncate text-xs" style={{ color: "var(--bt-muted)" }}>
                      {row.status === "qualifying" ? row.qualify_question ?? "What do they need?" : `${row.fee_eur == null ? "—" : formatFee(row.fee_eur)} · ${scored.daysAgo}d · ${REPUTATION_LABEL[row.reputation ?? "anon"].replace(/ buyer$/i, "")}`}
                    </div>
                  </div></TableCellContent>
                  <TableCellContent><div className="text-xs" style={{ color: "var(--bt-muted)" }}>{row.activity_count ?? 0}<br />{row.last_activity_at ? shortDate(row.last_activity_at) : "—"}</div></TableCellContent>
                </div>
              );
            })}
            {!shown.length && <p role="status" className="px-5 py-8 text-center text-sm" style={{ color: "var(--bt-muted)" }}>
              {loading ? "Loading demand…" : error ? "Demand unavailable." : query ? "No demand matches your search." : `No ${filter === "open" ? "open demand" : filter === "qualifying" ? "demand to qualify" : "closed demand"}.`}
            </p>}
          </div>
        </Card>
      </div>

      {selected && (
        <DemandPanel key={selected.id} demand={selected} today={today} onClose={() => setSelectedId(null)} onChanged={load}
          onEdit={() => setEditing(selected)} onOpenTrade={onOpenTrade} onOpenSupply={onOpenSupply} />
      )}
      {editing && (
        <DemandDialog demand={editing === "new" ? null : editing} onClose={() => setEditing(null)}
          onSaved={(saved) => { setEditing(null); setSelectedId(saved.id); void load(); }} />
      )}
    </div>
  );
}

const ACTIVITY_KINDS = ["note", "research", "outreach", "call", "quote", "supply"] as const;

function DemandPanel({ demand, today, onClose, onChanged, onEdit, onOpenTrade, onOpenSupply }: {
  demand: Demand; today: string; onClose: () => void; onChanged: () => void;
  onEdit: () => void; onOpenTrade: (lotId: string) => void; onOpenSupply?: (id: string) => void;
}) {
  const [activity, setActivity] = useState<Activity[]>([]);
  const [kind, setKind] = useState<string>("note");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [link, setLink] = useState("");
  const [refKind, setRefKind] = useState("url");
  const [choices, setChoices] = useState<{ id: string; label: string; kind: string }[]>([]);
  const [closing, setClosing] = useState(false);
  const [qualifying, setQualifying] = useState(false);
  const [question, setQuestion] = useState(demand.qualify_question ?? "");
  const [reason, setReason] = useState<ClosedReason>("no_longer_needed");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endpoint = `/api/bulk-trades/demand/${encodeURIComponent(demand.id)}`;
  const loadActivity = useCallback(async () => {
    try {
      const result = await request<{ activity: Activity[] }>(`${endpoint}/activity`);
      setActivity(result.activity);
    } catch (err) { setError(err instanceof Error ? err.message : "Could not load activity."); }
  }, [endpoint]);
  useEffect(() => { void loadActivity(); }, [loadActivity]);
  useEffect(() => {
    if (refKind !== "lot" && refKind !== "supply") return;
    let cancelled = false;
    void request<{ trades?: { id: string; title: string }[]; supply?: { id: string; seller: string; offers: string }[] }>(refKind === "lot" ? "/api/bulk-trades" : "/api/bulk-trades/supply")
      .then((result) => { if (!cancelled) setChoices(refKind === "lot"
        ? (result.trades ?? []).map((item) => ({ id: item.id, label: item.title, kind: "lot" }))
        : (result.supply ?? []).map((item) => ({ id: item.id, label: `${item.seller} · ${item.offers}`, kind: "supply" }))); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : "Could not load links."); });
    return () => { cancelled = true; };
  }, [refKind]);
  async function run(action: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try { await action(); await loadActivity(); onChanged(); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not save."); }
    finally { setBusy(false); }
  }
  const patch = (value: object) => request(endpoint, { method: "PATCH", body: JSON.stringify(value) });
  const add = (value: object) => request(`${endpoint}/activity`, { method: "POST", body: JSON.stringify(value) });
  return <aside aria-label="Demand detail" className="flex w-full max-w-[480px] shrink-0 flex-col gap-4 self-start border p-4" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
    <header className="flex items-start gap-3">
      <DemandScore demand={demand} today={today} />
      <div className="min-w-0 flex-1"><h2 className="font-semibold">{demand.buyer}</h2><p className="text-sm">{demand.wants}</p></div>
      <button type="button" aria-label="Dismiss demand detail" onClick={onClose}>×</button>
    </header>
    <div className="flex flex-wrap gap-2">
      <button disabled={busy} className={buttonClass} style={buttonStyle} onClick={() => run(() => patch({ action: "confirm" }))}>{demand.status === "closed" ? "Reopen" : "Still wanted"}</button>
      <button disabled={busy} className={buttonClass} style={buttonStyle} onClick={() => setQualifying(!qualifying)}>Qualify</button>
      {demand.status !== "closed" && <button className={buttonClass} style={buttonStyle} onClick={() => setClosing(!closing)}>Close</button>}
      <button className={buttonClass} style={buttonStyle} onClick={onEdit}>Edit</button>
    </div>
    {qualifying && <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); void run(async () => { await patch({ status: "qualifying", qualify_question: question }); setQualifying(false); }); }}>
      <input required aria-label="Qualification question" className="min-w-0 flex-1 border p-2 text-sm" value={question} onChange={(event) => setQuestion(event.target.value)} />
      <button disabled={busy} className={buttonClass} style={buttonStyle}>Save</button>
    </form>}
    {demand.status === "qualifying" && <div className="text-sm">
      <p>{demand.qualify_question}</p>
      <button disabled={busy} className="mt-1 text-xs underline" onClick={() => run(() => patch({ qualify_asked_on: today }))}>{demand.qualify_asked_on ? `Sent ${shortDate(demand.qualify_asked_on)} · send again` : "Question sent today"}</button>
    </div>}
    {closing && <div className="flex gap-2">
      <select aria-label="Why" className="min-w-0 flex-1 border text-sm" value={reason} onChange={(event) => setReason(event.target.value as ClosedReason)}>{CLOSED_REASONS.map((value) => <option key={value} value={value}>{CLOSED_REASON_LABEL[value]}</option>)}</select>
      <button disabled={busy} className={buttonClass} style={buttonStyle} onClick={() => run(async () => { await patch({ action: "close", reason }); setClosing(false); })}>Close demand</button>
    </div>}
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs" style={{ color: "var(--bt-muted)" }}>
      <span>{volumeLabel(demand) ?? demand.quantity ?? "Qty —"}</span><span>{priceLabel(demand) ?? "Price —"}</span><span>{demand.location ?? "Location —"}</span>
      {demand.needed_by && <span>By {shortDate(demand.needed_by)}</span>}
      {demand.source_url && <a href={demand.source_url} target="_blank" rel="noreferrer" className="underline">{demand.source_label ?? "Source"}</a>}
    </div>
    {(demand.note || demand.source_quote || specLines(demand.spec).length > 0) && <details className="text-xs" style={{ color: "var(--bt-muted)" }}>
      <summary className="cursor-pointer">Context</summary>
      {demand.note && <p className="mt-2 whitespace-pre-wrap">{demand.note}</p>}
      {specLines(demand.spec).map((line) => <p key={line}>{line}</p>)}
      {demand.source_quote && <p className="mt-2">“{demand.source_quote}”</p>}
    </details>}
    <details className="border-t pt-3 text-sm" style={{ borderColor: "var(--bt-divider)" }}>
      <summary className="cursor-pointer">Suggested supply · {demand.fits.length}</summary>
      {demand.fits.map((fit) => <div key={fit.lot_id} className="flex items-center gap-2 py-2">
        <button type="button" className="min-w-0 flex-1 truncate text-left hover:underline" title={fit.reason} onClick={() => onOpenTrade(fit.lot_id)}>{fit.title}</button>
        <button disabled={busy || activity.some((entry) => entry.kind === "supply" && entry.ref_kind === "lot" && entry.ref_id === fit.lot_id)} className={buttonClass} style={buttonStyle} onClick={() => run(() => add({ kind: "supply", title: fit.title, body: fit.reason, refKind: "lot", refId: fit.lot_id }))}>Pin</button>
      </div>)}
    </details>
    <section aria-label="Activity" className="border-t pt-3" style={{ borderColor: "var(--bt-divider)" }}>
      <h3 className="mb-2 text-sm font-semibold">Activity</h3>
      <form className="flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); void run(async () => {
        await add({ kind, title, body: body || undefined, ...(link ? { refKind, refId: link } : {}) });
        setTitle(""); setBody(""); setLink("");
      }); }}>
        <div className="flex gap-2">
          <select aria-label="Activity kind" className="border p-1 text-xs" value={kind} onChange={(event) => setKind(event.target.value)}>{ACTIVITY_KINDS.map((value) => <option key={value} value={value}>{value[0].toUpperCase() + value.slice(1)}</option>)}</select>
          <input required aria-label="Activity title" placeholder="What did we do?" className="min-w-0 flex-1 border p-2 text-sm" value={title} onChange={(event) => setTitle(event.target.value)} />
          <button disabled={busy || !title.trim()} className={buttonClass} style={buttonStyle}>Add</button>
        </div>
        <details><summary className="cursor-pointer text-xs" style={{ color: "var(--bt-muted)" }}>Details / link</summary>
          <textarea aria-label="Activity body" placeholder="Note" className="mt-2 w-full border p-2 text-sm" value={body} onChange={(event) => setBody(event.target.value)} />
          <div className="flex gap-2">
            <select aria-label="Link type" className="border text-xs" value={refKind} onChange={(event) => setRefKind(event.target.value)}><option value="url">URL</option><option value="lot">Lot</option><option value="supply">Supply</option><option value="stock">Stock item</option></select>
            <input aria-label="Activity link" type={refKind === "url" || refKind === "stock" ? "url" : "text"} role={refKind === "lot" || refKind === "supply" ? "combobox" : undefined} list={refKind === "lot" || refKind === "supply" ? `activity-links-${demand.id}` : undefined} placeholder={refKind === "url" || refKind === "stock" ? "Paste URL" : "Pick an item"} className="min-w-0 flex-1 border p-2 text-sm" value={link} onChange={(event) => setLink(event.target.value)} />
            <datalist id={`activity-links-${demand.id}`}>{choices.filter((item) => item.kind === refKind).map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</datalist>
          </div>
        </details>
      </form>
      <ErrorText error={error} />
      {!activity.length && <p className="py-4 text-xs" style={{ color: "var(--bt-muted)" }}>No activity yet.</p>}
      <ol className="mt-3">{activity.map((entry) => <li key={entry.id} className="border-t py-3 text-sm" style={{ borderColor: "var(--bt-divider)" }}>
        <div className="flex items-center gap-2"><span className="text-xs capitalize" style={{ color: "var(--bt-muted)" }}>{entry.kind}</span><time className="ml-auto text-xs" dateTime={entry.occurred_at}>{shortDate(entry.occurred_at)}</time>
          <button type="button" disabled={busy} aria-label={`Delete ${entry.title}`} onClick={() => run(() => request(`${endpoint}/activity/${entry.id}`, { method: "DELETE" }))}>×</button>
        </div>
        {entry.ref_kind === "lot" && entry.ref_id ? <button className="text-left font-medium underline" onClick={() => onOpenTrade(entry.ref_id!)}>{entry.title}</button>
          : entry.ref_kind === "supply" && entry.ref_id ? <button className="text-left font-medium underline" onClick={() => onOpenSupply?.(entry.ref_id!)}>{entry.title}</button>
          : entry.ref_id && /^https?:\/\//i.test(entry.ref_id) ? <a className="font-medium underline" href={entry.ref_id} target="_blank" rel="noreferrer">{entry.title}</a>
          : <p className="font-medium">{entry.title}</p>}
        {entry.body && <p className="mt-1 whitespace-pre-wrap text-xs" style={{ color: "var(--bt-muted)" }}>{entry.body}</p>}
      </li>)}</ol>
    </section>
  </aside>;
}

function ranking(demand: Demand, today: string) {
  return scoreDemand({ feeEur: demand.fee_eur, priceBasis: demand.price_basis, reputation: demand.reputation,
    askedOn: demand.observed_on && demand.confirmed_on
      ? (demand.observed_on > demand.confirmed_on ? demand.observed_on : demand.confirmed_on)
      : demand.observed_on ?? demand.confirmed_on }, today);
}


function DemandScore({ demand, today }: { demand: Demand; today: string }) {
  const result = ranking(demand, today);
  if (result.score == null) { return <span className="text-xs" style={{ color: "var(--bt-amber)" }}>Needs quantity</span>; }
  const color = result.score >= 80 ? "var(--bt-red)" : result.score >= 60 ? "var(--bt-amber)" : result.score >= 40 ? "var(--bt-green)" : "var(--bt-muted)";
  const arithmetic = `${formatFee(demand.fee_eur)} × ${demand.price_basis === "buyer" ? "1 (buyer budget)" : "½ (our estimate)"} × ${Math.round(result.closeChance * 100)}% × ${result.freshness.toFixed(2)} = ${formatFee(result.expectedFee ?? 0)} expected`;
  return <span tabIndex={0} title={arithmetic} aria-label={`${result.score} ${result.band}. ${arithmetic}`} className="inline-flex flex-col items-center gap-1">
    <span className="relative inline-flex h-11 w-11 items-center justify-center font-semibold" style={{ color }}>
      <svg aria-hidden="true" viewBox="0 0 40 40" className="absolute inset-0 h-full w-full -rotate-90">
        <circle cx="20" cy="20" r="17" fill="none" stroke="var(--bt-divider)" strokeWidth="3" />
        <circle cx="20" cy="20" r="17" fill="none" stroke="currentColor" strokeWidth="3" pathLength="100" strokeDasharray={`${result.score} 100`} />
      </svg>{result.score}
    </span>
  </span>;
}

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
    product_family: demand?.product_family ?? "", fee_eur: numberText(demand?.fee_eur),
    price_basis: demand?.price_basis ?? "estimate", reputation: demand?.reputation ?? "anon",
    status: demand?.status ?? "open", qualify_question: demand?.qualify_question ?? "",
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
      kind: draft.kind,
      ...(request_ ? { needed_by: draft.needed_by || null } : { basis: draft.basis }),
      volume, volume_unit: volume === null ? null : draft.volume_unit,
      max_price: maxPrice, price_currency: maxPrice === null ? null : draft.price_currency, price_unit: maxPrice === null ? null : draft.price_unit,
      spec,
      fee_eur: toNumber(draft.fee_eur), price_basis: draft.price_basis, reputation: draft.reputation,
      product_family: draft.product_family.trim() || null, qualify_question: draft.qualify_question.trim() || null,
      ...(demand?.status === "closed" ? {} : { status: draft.status }),
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
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Product family">{form.input("product_family", { placeholder: "e.g. VW MEB" })}</FormField>
        {demand?.status !== "closed" && <FormField label="Status">{form.select("status", ["open", "qualifying"], { open: "Demand", qualifying: "Qualifying" })}</FormField>}
        <FormField label="Expected fee (EUR)">{form.input("fee_eur", { type: "number", min: 0, step: "any" })}</FormField>
        <FormField label="Price basis">{form.select("price_basis", ["buyer", "estimate"], { buyer: "Buyer budget", estimate: "Our estimate" })}</FormField>
        <FormField label="Reputation">{form.select("reputation", ["paid", "active", "email", "inbound", "anon"], REPUTATION_LABEL)}</FormField>
      </div>
      {form.draft.status === "qualifying" && <FormField label="Qualification question">{form.input("qualify_question")}</FormField>}
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
