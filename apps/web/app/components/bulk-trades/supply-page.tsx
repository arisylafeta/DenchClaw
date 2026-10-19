"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Supply, SupplyFeedRow } from "@/lib/bulk-supply";
import type { BulkTradesRoute } from "@/lib/bulk-trades-url";
import type { Demand } from "@/lib/bulk-demand";
import { checkReason } from "@/lib/bulk-demand";
import { todayInLondon } from "@/lib/bulk-trades";
import { sizeLabel } from "@/lib/bulk-supply";
import { shortDate } from "@/lib/bulk-trade-details";
import {
  SUPPLY_CLOSED_REASONS,
  SUPPLY_CLOSED_LABEL,
  type SupplyClosedReason,
} from "@/lib/bulk-supply";
import { Card, DetailSheet, ErrorText, peekShared, request, sharedGet } from "./trade-ui";
import { ChatHint, SheetTabs, rowFocus } from "./demand-page";
import styles from "./bulk-detail.module.css";
import { CompanyContext } from "./company-context";

const KIND = {
  supply: "Offer",
  trade: "Lot",
  auction: "Auction",
  stock: "Stock",
} as const;
const SUPPLY_URL = "/api/bulk-trades/supply";
const DEMAND_URL = "/api/bulk-trades/demand";

export function SupplyPage({
  onOpenDemand,
  initialSupplyId,
  route,
  onRouteChange,
}: {
  onOpenDemand?: (id: string) => void;
  initialSupplyId?: string | null;
  /** The page's URL state. Without it the page keeps its state locally. */
  route?: Pick<BulkTradesRoute, "supply" | "status" | "query">;
  onRouteChange?: (patch: Partial<BulkTradesRoute>, mode: "push" | "replace") => void;
}) {
  initialSupplyId = route ? route.supply : initialSupplyId;
  const cached = peekShared<{ supply: Supply[]; feed: SupplyFeedRow[] }>(SUPPLY_URL);
  const [supply, setSupply] = useState<Supply[]>(cached?.supply ?? []);
  const [feed, setFeed] = useState<SupplyFeedRow[]>(cached?.feed ?? []);
  const [demand, setDemand] = useState<Demand[]>(() => peekShared<{ demand: Demand[] }>(DEMAND_URL)?.demand ?? []);
  const [selectedId, setSelectedState] = useState(initialSupplyId ?? null);
  const [query, setQueryState] = useState(route?.query ?? "");
  const [filter, setFilterState] = useState(route?.status ?? "open");
  const setSelectedId = (id: string | null) => { setSelectedState(id); onRouteChange?.({ supply: id }, "push"); };
  const setQuery = (value: string) => { setQueryState(value); onRouteChange?.({ query: value || null }, "replace"); };
  const setFilter = (value: string) => { setFilterState(value); onRouteChange?.({ status: value === "open" ? null : value }, "replace"); };
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!cached);
  const latest = useRef({ supply: 0, demand: 0 });
  // Supply and demand load side by side; the supply rows never wait for demand.
  const load = useCallback(async () => {
    const seq = ++latest.current.supply;
    const demandSeq = ++latest.current.demand;
    void sharedGet<{ demand: Demand[] }>(DEMAND_URL)
      .then((data) => { if (demandSeq === latest.current.demand) setDemand(data.demand); })
      .catch(() => { /* demand only adds context here */ });
    try {
      const data = await sharedGet<{ supply: Supply[]; feed: SupplyFeedRow[] }>(SUPPLY_URL);
      if (seq !== latest.current.supply) return;
      setSupply(data.supply);
      setFeed(data.feed);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load supply.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    setSelectedState(initialSupplyId ?? null);
  }, [initialSupplyId]);
  useEffect(() => {
    if (!route) return;
    setFilterState(route.status ?? "open");
    setQueryState(route.query ?? "");
  }, [route?.status, route?.query]); // eslint-disable-line react-hooks/exhaustive-deps
  const today = todayInLondon();
  const closedSupply: SupplyFeedRow[] = supply
    .filter((row) => row.status === "closed")
    .map((row) => ({
      id: row.id,
      kind: "supply",
      title: row.offers,
      seller: row.seller,
      size: sizeLabel(row),
      location: row.location,
      seen: row.observed_on,
      status: row.status,
      href: `/?path=bulk_trade&supply=${encodeURIComponent(row.id)}`,
      suppliers: [row.seller],
      verified: null,
      count: null,
    }));
  const shown = (filter === "closed" ? closedSupply : feed).filter(
    (row) =>
      (initialSupplyId !== "stock" || row.kind === "stock") &&
      (filter === "closed"
        ? row.status === "closed"
        : row.status !== "closed") &&
      `${row.title} ${row.seller ?? ""} ${row.location ?? ""}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const selected = [...feed, ...closedSupply].find(
    (row) => row.id === selectedId || row.id === `supply:${selectedId}`,
  );
  const detail = supply.find(
    (row) => row.id === selectedId || `supply:${row.id}` === selectedId,
  );
  const columns =
    "grid-cols-[80px_minmax(150px,1fr)_minmax(240px,2fr)_110px_90px]";
  return (
    <div className="space-y-5">
      <ErrorText error={error} />
      <div className="flex gap-3">
        <div className="flex gap-1">
          {["open", "closed"].map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={value === filter}
              className={`${rowFocus} px-3 py-2 text-[13px] capitalize`}
              style={{
                background:
                  value === filter ? "var(--bt-row-hover)" : undefined,
              }}
              onClick={() => setFilter(value)}
            >
              {value}
            </button>
          ))}
        </div>
        <input
          type="search"
          aria-label="Search supply"
          placeholder="Search sellers or inventory"
          className="border px-3 text-[13px]"
          style={{
            background: "var(--bt-surface)",
            borderColor: "var(--bt-border)",
          }}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <Card label="Supply" className="overflow-x-auto">
        <div className="min-w-[850px]">
          <div
            className={`grid ${columns} gap-4 border-b px-4 py-2 text-[11px] uppercase tracking-wider`}
            style={{
              color: "var(--bt-muted)",
              borderColor: "var(--bt-border)",
            }}
          >
            <span>Kind</span>
            <span>Seller</span>
            <span>Supply</span>
            <span className="text-right">Size</span>
            <span>Seen</span>
          </div>
          {shown.map((row) => (
            <button
              key={row.id}
              type="button"
              className={`${rowFocus} grid w-full ${columns} items-center gap-4 border-b px-4 py-3 text-left hover:bg-[var(--bt-row-hover)]`}
              style={{ borderColor: "var(--bt-divider)" }}
              onClick={() => setSelectedId(row.id)}
            >
              <span className={styles.chip}>{KIND[row.kind]}</span>
              <span
                className="min-w-0 truncate text-[14px] font-semibold"
                title={row.seller ?? undefined}
              >
                {row.seller ?? ""}
              </span>
              <div>
                <p className="text-[14px] font-semibold">{row.title}</p>
                {row.location && (
                  <p
                    className="mt-1 text-[13px]"
                    style={{ color: "var(--bt-muted)" }}
                  >
                    {row.location}
                  </p>
                )}
              </div>
              <span className="text-right text-[13px] tabular-nums">
                {row.size ?? ""}
              </span>
              <span
                className="text-[13px]"
                style={{ color: "var(--bt-muted)" }}
              >
                {row.seen ? shortDate(row.seen.slice(0, 10)) : ""}
              </span>
            </button>
          ))}
          {!shown.length && (
            <p
              className="py-8 text-center text-[13px]"
              style={{ color: "var(--bt-muted)" }}
            >
              {loading
                ? "Loading supply…"
                : error
                  ? "Supply unavailable."
                  : "No supply here."}
            </p>
          )}
        </div>
      </Card>
      {(selected || detail) && (
        <SupplyPanel
          key={selectedId}
          row={selected}
          supply={detail}
          matches={demand.flatMap((buyer) => {
            if (
              buyer.status !== "open" ||
              checkReason(buyer, today) === "past_needed_by"
            )
              return [];
            const fit = buyer.inventory_matches?.find(
              (match) => match.id === selected?.id,
            );
            return fit
              ? [
                  {
                    demand_id: buyer.id,
                    buyer: buyer.buyer,
                    reason: fit.reason,
                  },
                ]
              : [];
          })}
          onClose={() => setSelectedId(null)}
          onChanged={load}
          onOpenDemand={onOpenDemand}
        />
      )}
    </div>
  );
}
function SupplyPanel({
  row,
  supply,
  matches,
  onClose,
  onChanged,
  onOpenDemand,
}: {
  row?: SupplyFeedRow;
  supply?: Supply;
  matches: { demand_id: string; buyer: string; reason: string }[];
  onClose: () => void;
  onChanged: () => void;
  onOpenDemand?: (id: string) => void;
}) {
  const [tab, setTab] = useState("Overview");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [closing, setClosing] = useState(false);
  const [reason, setReason] = useState<SupplyClosedReason>("gone");
  const [showAllBuyers, setShowAllBuyers] = useState(false);
  async function patch(body: object) {
    if (!supply) return;
    setBusy(true);
    try {
      await request(
        `/api/bulk-trades/supply/${encodeURIComponent(supply.id)}`,
        { method: "PATCH", body: JSON.stringify(body) },
      );
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }
  const id = supply?.id ?? row!.id;
  const fits = supply?.fits ?? matches;
  return (
    <DetailSheet title="Supply detail" onClose={onClose}>
      <header className="pr-6">
        <h2 className="text-[20px] font-semibold">
          {row?.seller ?? supply?.seller ?? row?.title}
        </h2>
        <div className="mt-2 flex gap-2">
          <span className={styles.chip}>{row ? KIND[row.kind] : "Offer"}</span>
          <span className={styles.status}>{row?.status ?? supply?.status}</span>
        </div>
      </header>
      <p className="text-[13px]" style={{ color: "var(--bt-muted)" }}>
        {row?.title ?? supply?.offers}
      </p>
      <SheetTabs
        tabs={["Overview", "Suitable buyers", "Activity"]}
        value={tab}
        onChange={setTab}
      />
      {tab === "Overview" && (
        <>
          <dl className={styles.facts}>
            {[
              ["Size", row?.size ?? (supply ? sizeLabel(supply) : null)],
              ["Quantity", supply?.quantity],
              ["Location", row?.location ?? supply?.location],
              ["Seen", row?.seen ?? supply?.observed_on],
            ].map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value ?? ""}</dd>
              </div>
            ))}
          </dl>
          {supply?.source_quote && (
            <blockquote
              className="border-l-2 pl-3 text-[13px]"
              style={{
                color: "var(--bt-muted)",
                borderColor: "var(--bt-border)",
              }}
            >
              {supply.source_quote}
            </blockquote>
          )}
          {supply?.source_url ? (
            <a
              href={supply.source_url}
              className={`${rowFocus} text-[13px] underline`}
              target="_blank"
              rel="noreferrer"
            >
              {supply.source_label ?? "Source"}
            </a>
          ) : (
            row &&
            row.kind !== "supply" && (
              <a
                href={row.href}
                className={`${rowFocus} text-[13px] underline`}
              >
                View {KIND[row.kind].toLowerCase()}
              </a>
            )
          )}
          {supply && (
            <div className="flex gap-3">
              {closing && supply.status !== "closed" && (
                <select
                  aria-label="Why"
                  value={reason}
                  onChange={(event) =>
                    setReason(event.target.value as SupplyClosedReason)
                  }
                >
                  {SUPPLY_CLOSED_REASONS.map((value) => (
                    <option key={value} value={value}>
                      {SUPPLY_CLOSED_LABEL[value]}
                    </option>
                  ))}
                </select>
              )}
              <button
                type="button"
                disabled={busy}
                className={`${rowFocus} border px-3 py-2 text-[13px]`}
                style={{ borderColor: "var(--bt-border)" }}
                onClick={() => {
                  if (supply.status === "closed")
                    void patch({ action: "reopen" });
                  else if (!closing) setClosing(true);
                  else void patch({ action: "close", reason });
                }}
              >
                {supply.status === "closed"
                  ? "Reopen"
                  : closing
                    ? "Close batch"
                    : "Close…"}
              </button>
              {closing && (
                <button
                  type="button"
                  className="text-[13px]"
                  onClick={() => setClosing(false)}
                >
                  Cancel
                </button>
              )}
            </div>
          )}
        </>
      )}
      {tab === "Overview" && supply && (
        <CompanyContext notes={supply.context_notes} />
      )}
      {tab === "Suitable buyers" && (
        <section>
          {!fits.length && (
            <p className="text-[13px]" style={{ color: "var(--bt-muted)" }}>
              No matching buyers.
            </p>
          )}
          {(showAllBuyers ? fits : fits.slice(0, 5)).map((fit) => (
            <div
              key={fit.demand_id}
              className="border-b py-4"
              style={{ borderColor: "var(--bt-divider)" }}
            >
              <button
                type="button"
                className={`${rowFocus} text-left text-[14px] font-semibold`}
                onClick={() => onOpenDemand?.(fit.demand_id)}
              >
                {fit.buyer}
              </button>
              <p
                className="mt-1 text-[13px]"
                style={{ color: "var(--bt-muted)" }}
              >
                {fit.reason}
              </p>
              {supply && (
                <button
                  type="button"
                  disabled={busy}
                  className={`${rowFocus} mt-2 text-[13px] underline`}
                  onClick={() =>
                    patch({ action: "hide_fit", demand_id: fit.demand_id })
                  }
                >
                  Not a fit
                </button>
              )}
            </div>
          ))}
          {fits.length > 5 && (
            <button
              type="button"
              className={`${rowFocus} mt-3 text-[13px] underline`}
              onClick={() => setShowAllBuyers(!showAllBuyers)}
            >
              {showAllBuyers ? "Show less" : `+${fits.length - 5} more`}
            </button>
          )}
        </section>
      )}
      {tab === "Activity" && (
        <section>
          {supply?.source_quote ? (
            <>
              <h3 className="text-[14px] font-semibold">Source observation</h3>
              <p
                className="mt-2 text-[13px]"
                style={{ color: "var(--bt-muted)" }}
              >
                {supply.source_quote}
              </p>
              {supply.source_url && (
                <a
                  href={supply.source_url}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 text-[13px] underline"
                >
                  {supply.source_label ?? "Source"}
                </a>
              )}
            </>
          ) : (
            <p className="text-[13px]" style={{ color: "var(--bt-muted)" }}>
              No activity recorded.
            </p>
          )}
        </section>
      )}
      <ErrorText error={error} />
      <ChatHint id={id} />
    </DetailSheet>
  );
}

/** One supply record, opened by id from the sheet or a shared link. */
export function SupplyDetail({ id, onClose, onOpenDemand }: { id: string; onClose: () => void; onOpenDemand?: (id: string) => void }) {
  const cached = peekShared<{ supply: Supply[]; feed: SupplyFeedRow[] }>(SUPPLY_URL);
  const [supply, setSupply] = useState<Supply[] | null>(cached?.supply ?? null);
  const [feed, setFeed] = useState<SupplyFeedRow[]>(cached?.feed ?? []);
  const [demand, setDemand] = useState<Demand[]>(() => peekShared<{ demand: Demand[] }>(DEMAND_URL)?.demand ?? []);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);
  const load = useCallback(async () => {
    const seq = ++latest.current;
    void sharedGet<{ demand: Demand[] }>(DEMAND_URL)
      .then((data) => { if (seq === latest.current) setDemand(data.demand); })
      .catch(() => { /* demand only adds the buyer fits */ });
    try {
      const data = await sharedGet<{ supply: Supply[]; feed: SupplyFeedRow[] }>(SUPPLY_URL);
      if (seq !== latest.current) return;
      setSupply(data.supply);
      setFeed(data.feed);
      setError(null);
    } catch (err) {
      if (seq === latest.current) setError(err instanceof Error ? err.message : "Could not load this offer.");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const today = todayInLondon();
  const row = feed.find((candidate) => candidate.id === id || candidate.id === `supply:${id}`);
  const detail = supply?.find((candidate) => candidate.id === id || `supply:${candidate.id}` === id);
  if (!row && !detail) {
    return (
      <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-3">
        <button type="button" onClick={onClose} className="w-fit text-[13px] hover:underline" style={{ color: "var(--bt-muted)" }}>← Trades Preview</button>
        <ErrorText error={error} />
        <p className="text-[13px]" style={{ color: "var(--bt-muted)" }}>{supply && !error ? "This offer no longer exists." : error ? "" : "Loading…"}</p>
      </div>
    );
  }
  const matches = demand.flatMap((buyer) => {
    if (buyer.status !== "open" || checkReason(buyer, today) === "past_needed_by") return [];
    const fit = buyer.inventory_matches?.find((match) => match.id === row?.id);
    return fit ? [{ demand_id: buyer.id, buyer: buyer.buyer, reason: fit.reason }] : [];
  });
  return <SupplyPanel key={id} row={row} supply={detail} matches={matches} onClose={onClose} onChanged={load} onOpenDemand={onOpenDemand} />;
}
