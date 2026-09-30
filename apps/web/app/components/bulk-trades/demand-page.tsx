"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CLOSED_REASONS,
  CLOSED_REASON_LABEL,
  isStale,
  type ClosedReason,
  type Demand,
  type DemandInput,
} from "@/lib/bulk-demand";
import { shortDate, type Proposal } from "@/lib/bulk-trade-details";
import { CrmSearch } from "./buyer-dialogs";
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

type Filter = "open" | "check" | "closed";

type Props = {
  today: string;
  onOpenTrade: (lotId: string) => void;
};

const COLUMNS = "grid-cols-[minmax(150px,1fr)_minmax(240px,2.2fr)_110px_110px_110px_minmax(140px,1fr)]";

/** Who wants what (bulk only, 2+ units), which live trades fit, and new demand from the inbox. */
export function DemandPage({ today, onOpenTrade }: Props) {
  const [demand, setDemand] = useState<Demand[]>([]);
  const [possible, setPossible] = useState<Proposal[]>([]);
  const [filter, setFilter] = useState<Filter>("open");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Demand | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await request<{ demand: Demand[]; possible: Proposal[] }>("/api/bulk-trades/demand");
      setDemand(data.demand);
      setPossible(data.possible);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load demand.");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const open = demand.filter((row) => row.status === "open");
  const toCheck = open.filter((row) => isStale(row, today));
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const rows = filter === "closed" ? demand.filter((row) => row.status === "closed")
      : filter === "check" ? toCheck
        : [...open.filter((row) => !isStale(row, today)), ...toCheck];
    return needle ? rows.filter((row) => `${row.buyer} ${row.contact ?? ""} ${row.wants}`.toLowerCase().includes(needle)) : rows;
  }, [demand, filter, query, today, open, toCheck]);
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
            {segment("open", `Open ${open.length}`)}
            {segment("check", `To check ${toCheck.length}`)}
            {segment("closed", "Closed")}
          </div>
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search demand"
            placeholder="Search buyers or wants" className="h-8 w-full max-w-[340px] rounded-none border px-2.5 text-[13px]"
            style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)", color: "var(--bt-text)" }} />
          <span className="flex-1" />
          <span className="text-[13px]" style={{ color: "var(--bt-muted)" }}>Bulk only, 2+ units</span>
          <button type="button" onClick={() => setEditing("new")} className="h-9 rounded-none bg-[var(--bt-accent)] px-3.5 text-sm font-semibold hover:bg-[var(--bt-accent-hover)]"
            style={{ color: "var(--bt-on-accent)" }}>
            Add demand
          </button>
        </div>

        <Card label="Demand" className="overflow-x-auto">
          <div className="min-w-[900px]">
            <div className={`bt-label grid ${COLUMNS} gap-3.5 border-b px-5 py-2.5`} style={{ background: "var(--bt-table-head)", borderColor: "var(--bt-divider)" }}>
              <span>Buyer</span><span>Wants</span><span>Qty</span><span>Where</span><span>Confirmed</span><span>Fits</span>
            </div>
            {shown.map((row) => {
              const stale = isStale(row, today);
              return (
                <button key={row.id} type="button" onClick={() => setSelectedId(row.id)} aria-pressed={row.id === selectedId}
                  className={`grid w-full ${COLUMNS} items-center gap-3.5 border-b px-5 py-3 text-left last:border-b-0 hover:bg-[var(--bt-row-hover)]`}
                  style={{ borderColor: "var(--bt-divider)", color: stale || row.status === "closed" ? "var(--bt-muted)" : "var(--bt-text)",
                    background: row.id === selectedId ? "var(--bt-row-hover)" : undefined }}>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold">{row.buyer}</div>
                    {row.contact && <div className="truncate text-xs" style={{ color: "var(--bt-muted)" }}>{row.contact}</div>}
                  </div>
                  <span className="text-[13px] leading-snug">{row.wants}</span>
                  <span className="bt-mono text-[13px]">{row.quantity ?? ""}</span>
                  <span className="text-[13px]">{row.location ?? ""}</span>
                  <span className="flex flex-col items-start gap-1 text-[13px]">
                    {row.confirmed_on ? shortDate(row.confirmed_on) : "Never"}
                    {stale && (
                      <span className="rounded-none border px-1.5 py-px text-xs font-medium"
                        style={{ background: "var(--bt-amber-bg)", color: "var(--bt-amber)", borderColor: "var(--bt-amber-border)" }}>Still wanted?</span>
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
          <div className="bt-label">Demand</div>
          <h2 className="mt-1 text-lg font-semibold">{demand.buyer}</h2>
          {(demand.contact || demand.email) && (
            <div className="text-[13px]" style={{ color: "var(--bt-muted)" }}>{[demand.contact, demand.email].filter(Boolean).join(" · ")}</div>
          )}
        </div>
        <button type="button" onClick={onClose} className="text-sm" style={{ color: "var(--bt-muted)" }}>Close</button>
      </div>
      <p className="text-[15px] leading-snug">{demand.wants}</p>
      <dl className="grid grid-cols-[100px_1fr] gap-y-1.5 text-sm">
        <dt style={{ color: "var(--bt-muted)" }}>Quantity</dt><dd>{demand.quantity ?? "—"}</dd>
        <dt style={{ color: "var(--bt-muted)" }}>Where</dt><dd>{demand.location ?? "—"}</dd>
        <dt style={{ color: "var(--bt-muted)" }}>Confirmed</dt>
        <dd>{demand.confirmed_on ? shortDate(demand.confirmed_on) : "Never"}{isStale(demand, today) ? " · still wanted?" : ""}</dd>
        {demand.source_label && (<>
          <dt style={{ color: "var(--bt-muted)" }}>Source</dt>
          <dd>{demand.source_url
            ? <a href={demand.source_url} target="_blank" rel="noreferrer" className="hover:underline" style={{ color: "var(--bt-link)" }}>{demand.source_label}</a>
            : demand.source_label}</dd>
        </>)}
      </dl>
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
            onClick={() => run(() => patch({ action: "confirm" }))}>{demand.status === "closed" ? "Reopen" : "Still wanted"}</button>
          <button type="button" onClick={onEdit} className={`${buttonClass} h-9`} style={buttonStyle}>Edit</button>
          {demand.status === "open" && <button type="button" onClick={() => setClosing(true)} className={`${buttonClass} h-9`} style={buttonStyle}>Close…</button>}
        </div>
      )}
    </aside>
  );
}

function DemandDialog({ demand, onClose, onSaved }: {
  demand: Demand | null;
  onClose: () => void;
  onSaved: (demand: Demand) => void;
}) {
  const [paste, setPaste] = useState("");
  const [filling, setFilling] = useState(false);
  const [link, setLink] = useState<{ person_id?: string | null; company_id?: string | null }>({});
  const form = useForm({
    buyer: demand?.buyer ?? "", contact: demand?.contact ?? "", email: demand?.email ?? "", wants: demand?.wants ?? "",
    quantity: demand?.quantity ?? "", location: demand?.location ?? "", note: demand?.note ?? "",
  }, async (draft) => {
    const body: DemandInput = { ...link };
    for (const [key, value] of Object.entries(draft)) (body as Record<string, string | null>)[key] = value.trim() || null;
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
      form.setDraft((current) => ({ ...current, ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value)) }));
    } finally {
      setFilling(false);
    }
  });

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
        <FormField label="Quantity">{form.input("quantity", { placeholder: "e.g. 100+ packs, 7–8 a month" })}</FormField>
        <FormField label="Where">{form.input("location")}</FormField>
      </div>
      <FormField label="Note">{form.input("note")}</FormField>
      <p className="text-xs" style={{ color: "var(--bt-muted)" }}>Bulk only: 2 or more units.</p>
      <ErrorText error={form.error} />
    </Modal>
  );
}
