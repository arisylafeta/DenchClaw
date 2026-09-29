"use client";

import { useCallback, useEffect, useState } from "react";
import type { BulkTrade, TradeOwner, TradePatch } from "@/lib/bulk-trades";
import type { Buyer, Contact, TradeDetail, TradeField, TradeFile } from "@/lib/bulk-trade-details";
import { TradeData } from "./trade-data";
import { TradeEditor } from "./trade-editor";
import { TradeOverview } from "./trade-overview";
import { ErrorText, buttonClass, buttonStyle, request, tradeUrl } from "./trade-ui";

type Tab = "overview" | "data";

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
  const [tab, setTab] = useState<Tab>("overview");
  const [detail, setDetail] = useState<TradeDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

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
      aria-selected={tab === value}
      onClick={() => setTab(value)}
      className="border-b-2 px-3.5 py-3 text-sm"
      style={tab === value
        ? { borderColor: "var(--bt-text)", color: "var(--bt-text)", fontWeight: 600 }
        : { borderColor: "transparent", color: "var(--bt-muted)", fontWeight: 500 }}
    >
      {label}
    </button>
  );

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-col gap-2.5 border-b px-8 pt-5" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
        <nav aria-label="Breadcrumb" className="text-[13px]" style={{ color: "var(--bt-muted)" }}>
          <button type="button" onClick={onBack} className="hover:underline">Bulk Trades</button> / {trade.title}
        </nav>
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-[26px] font-semibold tracking-[-0.01em]">{trade.title}</h1>
          <span className="rounded-md px-[9px] py-[3px] text-xs font-semibold" style={{ background: "var(--bt-divider)", color: "var(--bt-text-2)" }}>
            {trade.trade_stage}
          </span>
          <span className="flex-1" />
          <button type="button" className={buttonClass} style={buttonStyle} onClick={() => setEditing(true)}>Edit trade</button>
        </div>
        {trade.fact_line && <p className="text-sm" style={{ color: "var(--bt-text-2)" }}>{trade.fact_line}</p>}
        <div role="tablist" aria-label="Trade sections" className="flex gap-1">
          {tabButton("overview", "Overview")}
          {tabButton("data", "Data and files")}
        </div>
      </header>

      <main className="flex-1 overflow-auto px-8 pb-8 pt-6">
        {tab === "overview" ? (
          <TradeOverview
            detail={detail}
            today={today}
            onProposalDecided={() => void load()}
            onTradePatch={patchTrade}
            onBuyer={(buyer: Buyer) => update((current) => ({ ...current, buyers: upsert(current.buyers, buyer) }))}
            onContacts={(contacts: Contact[]) => update((current) => ({ ...current, contacts }))}
          />
        ) : (
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
        )}
      </main>

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
