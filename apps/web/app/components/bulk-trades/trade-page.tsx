"use client";

import { useCallback, useEffect, useState } from "react";
import { WhatsappContext } from "../crm/whatsapp-context";
import { HOLD_STAGE, TRADE_STAGES, holdLabel, type BulkTrade, type TradeOwner, type TradePatch, type TradeStage } from "@/lib/bulk-trades";
import { shortDate, type Buyer, type Contact, type HistoryStatus, type TradeDetail, type TradeField, type TradeFile } from "@/lib/bulk-trade-details";
import { TradeData } from "./trade-data";
import { HoldDialog } from "./hold-dialog";
import { TradeEditor } from "./trade-editor";
import { ContactsCard, NextStepStrip, ShippingCard, TradeOverview } from "./trade-overview";
import { InboxUpdates } from "./inbox-updates";
import { ProposalRow } from "./proposal-row";
import { ErrorText, buttonClass, buttonStyle, request, tradeUrl } from "./trade-ui";

type Tab = "buyers" | "details" | "activity" | "whatsapp";

type Props = {
  tradeId: string;
  owners: TradeOwner[];
  today: string;
  onBack: () => void;
  /** Keeps the list in step with edits made here. */
  onTradeSaved: (trade: BulkTrade) => void;
  onOpenEvidence?: () => void;
};

const upsert = <T extends { id: string }>(items: T[], item: T) =>
  items.some((candidate) => candidate.id === item.id)
    ? items.map((candidate) => (candidate.id === item.id ? item : candidate))
    : [...items, item];

export function TradePage({ tradeId, owners, today, onBack, onTradeSaved, onOpenEvidence }: Props) {
  const [tab, setTab] = useState<Tab>("buyers");
  const [detail, setDetail] = useState<TradeDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [holding, setHolding] = useState(false);
  const [holdError, setHoldError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setDetail(await request<TradeDetail>(tradeUrl(tradeId)));
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load the trade.");
    }
  }, [tradeId]);

  useEffect(() => { void load(); }, [load]);

  const patchTrade = useCallback(async (patch: TradePatch) => {
    const { trade } = await request<{ trade: BulkTrade }>(tradeUrl(tradeId), { method: "PATCH", body: JSON.stringify(patch) });
    setDetail((current) => (current ? { ...current, trade } : current));
    onTradeSaved(trade);
  }, [tradeId, onTradeSaved]);

  const update = (change: (current: TradeDetail) => TradeDetail) =>
    setDetail((current) => (current ? change(current) : current));

  if (!detail) {
    return (
      <div className="px-8 py-6">
        <button type="button" onClick={onBack} className="text-[13px]" style={{ color: "var(--bt-muted)" }}>Bulk Trades</button>
        {loadError ? <ErrorText error={loadError} /> : <p className="mt-4 text-sm" style={{ color: "var(--bt-muted)" }}>Loading…</p>}
      </div>
    );
  }

  const { trade } = detail;
  const tabButton = (value: Tab, label: string) => (
    <button
      type="button"
      role="tab"
      aria-label={value === "activity" && detail.proposals?.length ? `${label} ${detail.proposals.length}` : label}
      aria-selected={tab === value}
      onClick={() => {
        setTab(value);
        if (value === "activity") {void load();}
      }}
      className="border-b-2 px-3.5 py-3 text-sm"
      style={tab === value
        ? { borderColor: "var(--bt-text)", color: "var(--bt-text)", fontWeight: 600 }
        : { borderColor: "transparent", color: "var(--bt-muted)", fontWeight: 500 }}
    >
      {label}
      {value === "activity" && !!detail.proposals?.length && (
        <span className="ml-2 px-1.5 py-0.5 text-xs" style={{ background: "var(--bt-badge)", color: "var(--bt-on-badge)" }}>
          {detail.proposals.length}
        </span>
      )}
    </button>
  );

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-col gap-2.5 border-b px-8 pt-5" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
        <nav aria-label="Breadcrumb" className="text-[13px]" style={{ color: "var(--bt-muted)" }}>
          <button type="button" onClick={onBack} className="hover:underline">Bulk Trades</button> / {trade.title}
        </nav>
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-[20px] font-semibold tracking-[-0.01em]">{trade.title}</h1>
          <select aria-label="Trade stage" value={trade.trade_stage} className="border px-2 py-1 text-sm" style={buttonStyle}
            onChange={(event) => {
              const stage = event.target.value as TradeStage;
              setHoldError(null);
              if (stage === HOLD_STAGE) {setHolding(true);}
              else {patchTrade({ trade_stage: stage }).catch((err) => setHoldError(err instanceof Error ? err.message : "Could not change stage."));}
            }}>
            {TRADE_STAGES.map((stage) => <option key={stage}>{stage}</option>)}
          </select>
          {trade.value && <span className="bt-mono text-sm font-semibold">{trade.value}</span>}
          <span className="flex-1" />
          {trade.trade_stage !== HOLD_STAGE && !["Done", "Lost"].includes(trade.trade_stage) && (
            <button type="button" className={buttonClass} style={buttonStyle} onClick={() => setHolding(true)}>Put on hold</button>
          )}
          <button type="button" className={buttonClass} style={buttonStyle} onClick={() => setEditing(true)}>Edit trade</button>
        </div>
        <p className="text-[13px]" style={{ color: "var(--bt-muted)" }}><span style={{ color: trade.has_seller ? undefined : "var(--bt-amber)" }}>{trade.seller_name || "No seller yet"}</span> → <span style={{ color: detail.buyers.length ? undefined : "var(--bt-amber)" }}>{detail.buyers.length ? detail.buyers.map((buyer) => buyer.name).join(", ") : "No buyer yet"}</span></p>
        <ErrorText error={holdError} />
        <ErrorText error={loadError} />
        {trade.trade_stage === HOLD_STAGE && (
          <div role="status" className="flex flex-wrap items-center gap-3 rounded-none border px-4 py-2.5"
            style={{ background: "var(--bt-table-head)", borderColor: "var(--bt-border)" }}>
            <span className="rounded-none border px-2 py-0.5 text-xs font-medium"
              style={trade.hold_until && trade.hold_until <= today
                ? { background: "var(--bt-red-bg)", color: "var(--bt-red)", borderColor: "var(--bt-red-border)" }
                : { background: "var(--bt-divider)", color: "var(--bt-text-2)", borderColor: "var(--bt-grey-border)" }}>
              {holdLabel(trade, today)}
            </span>
            <span className="flex-1 text-sm">{trade.hold_reason}</span>
            <button type="button" className={`${buttonClass} h-8`} style={buttonStyle} onClick={() => setHolding(true)}>Change</button>
            <button type="button" className={`${buttonClass} h-8`} style={buttonStyle}
              onClick={() => {
                setHoldError(null);
                patchTrade({ trade_stage: trade.hold_from_stage ?? "With buyers" })
                  .catch((err) => setHoldError(err instanceof Error ? err.message : "Could not resume."));
              }}>
              Resume ({trade.hold_from_stage ?? "With buyers"})
            </button>
          </div>
        )}
        <NextStepStrip detail={detail} today={today} linkTracking={!!detail.link_tracking} onTradePatch={patchTrade} />
        <div role="tablist" aria-label="Trade sections" className="flex gap-1">
          {tabButton("buyers", "Buyers")}
          {tabButton("details", "Details")}
          {tabButton("activity", "Activity")}
          {tabButton("whatsapp", "WhatsApp")}
        </div>
      </header>

      <main className="flex-1 overflow-auto px-8 pb-8 pt-6">
        {tab === "buyers" ? (
          <TradeOverview
            detail={detail}
            today={today}
            onProposalDecided={() => void load()}
            onTradePatch={patchTrade}
            onBuyer={(buyer: Buyer) => update((current) => ({ ...current, buyers: upsert(current.buyers, buyer) }))}
            onContacts={(contacts: Contact[]) => update((current) => ({ ...current, contacts }))}
          />
        ) : tab === "details" ? (
          <div className="flex flex-col gap-4">
          <TradeData
            detail={detail}
            onProposalDecided={() => void load()}
            onField={(field: TradeField) => update((current) => ({
              ...current,
              fields: [...current.fields.filter((candidate) => candidate.field_key !== field.field_key), field],
            }))}
            onFile={(file: TradeFile) => update((current) => ({ ...current, files: upsert(current.files, file) }))}
            onTradePatch={patchTrade}
          />
          <div className="grid gap-4 lg:grid-cols-2">
            <ShippingCard trade={trade} />
            <ContactsCard trade={trade} contacts={detail.contacts} onContacts={(contacts) => update((current) => ({ ...current, contacts }))} />
          </div>
          </div>
        ) : tab === "whatsapp" ? <WhatsappContext key={tradeId} tradeId={tradeId} /> : (
          <div className="flex flex-col gap-3">
            {!!detail.proposals?.length && <section aria-label="Pending updates" className="border" style={{ borderColor: "var(--bt-border)" }}>
              {detail.proposals.map((proposal) => <ProposalRow key={proposal.id} proposal={proposal} onDecided={() => void load()} />)}
            </section>}
            <HistoryButton tradeId={trade.id} history={detail.history ?? null} onRefresh={load} />
            <InboxUpdates tradeId={trade.id} applied={detail.applied ?? []} onChanged={() => void load()} />
            <section aria-label="Event history" className="border" style={{ borderColor: "var(--bt-border)" }}>
              <h2 className="px-4 py-2 text-sm font-semibold">History</h2>
              {!detail.events?.length && <p className="px-4 py-2 text-sm" style={{ color: "var(--bt-muted)" }}>No events.</p>}
              {detail.events?.map((event) => (
                <div key={event.id} className="flex items-center gap-3 border-t px-4 py-2 text-sm" style={{ borderColor: "var(--bt-divider)" }}>
                  <time className="shrink-0 text-xs" style={{ color: "var(--bt-muted)" }}>{shortDate(event.occurred_at.slice(0, 10))}</time>
                  <span className="shrink-0">{event.kind.replaceAll("_", " ")}</span>
                  <span className="truncate" title={JSON.stringify(event.changes)} style={{ color: "var(--bt-muted)" }}>
                    {Object.keys(event.changes).filter((key) => !["stage", "observed_outcome", "reconciliation_note", "confidence", "people_sent_count"].includes(key)).map((key) => key.replaceAll("_", " ")).join(" · ")}
                  </span>
                </div>
              ))}
            </section>
          </div>
        )}
      </main>

      {holding && (
        <HoldDialog trade={trade} today={today} onClose={() => setHolding(false)}
          onSave={async (hold) => {
            await patchTrade(trade.trade_stage === HOLD_STAGE ? hold : { trade_stage: HOLD_STAGE, ...hold });
            setHolding(false);
          }} />
      )}
      {editing && (
        <TradeEditor
          trade={trade}
          owners={owners}
          today={today}
          onClose={() => setEditing(false)}
          onSave={async (patch) => { await patchTrade(patch); setEditing(false); }}
          onOpenEvidence={onOpenEvidence}
        />
      )}
    </div>
  );
}

/**
 * Reads the trade's past emails and calls once and applies what belongs to it. While a pass runs, the page
 * refreshes itself so the findings appear when it is done.
 */
function HistoryButton({ tradeId, history, onRefresh }: {
  tradeId: string;
  history: HistoryStatus;
  onRefresh: () => Promise<void>;
}) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = history?.status === "running" || starting;

  useEffect(() => {
    if (!running) {return;}
    const timer = setInterval(() => { void onRefresh().then(() => setStarting(false)); }, 8000);
    return () => clearInterval(timer);
  }, [running, onRefresh]);

  async function start() {
    setError(null);
    setStarting(true);
    try {
      await request(tradeUrl(tradeId, "/history"), { method: "POST" });
    } catch (err) {
      setStarting(false);
      setError(err instanceof Error ? err.message : "Could not start.");
    }
  }

  const note = running
    ? null
    : history?.status === "failed"
      ? "Last read failed"
      : history?.finished_at
        ? `Read ${shortDate(history.finished_at.slice(0, 10))} · ${history.proposals_made} ${history.proposals_made === 1 ? "update" : "updates"}`
        : null;
  return (
    <div className="flex items-center gap-2">
      {(note || error) && (
        <span className="text-xs" style={{ color: error || history?.status === "failed" ? "var(--bt-red)" : "var(--bt-muted)" }}>
          {error ?? note}
        </span>
      )}
      <button type="button" className={buttonClass} style={buttonStyle} disabled={running} onClick={start}
        title="Read this trade's past emails and calls once, and propose what they contain">
        {running ? "Reading emails…" : "Find data in emails"}
      </button>
    </div>
  );
}

