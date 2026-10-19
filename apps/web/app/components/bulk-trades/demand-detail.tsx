"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Demand } from "@/lib/bulk-demand";
import { DemandPanel } from "./demand-panel";
import { ErrorText, peekShared, sharedGet } from "./trade-ui";

const DEMAND_URL = "/api/bulk-trades/demand";

/** One demand, opened by id from the sheet or a shared link. Closed and qualifying demand open too. */
export function DemandDetail({ id, today, onClose, onOpenTrade, onOpenSupply, onOpenDemand }: {
  id: string;
  today: string;
  onClose: () => void;
  onOpenTrade: (id: string) => void;
  onOpenSupply?: (id: string) => void;
  onOpenDemand?: (id: string) => void;
}) {
  const [demand, setDemand] = useState<Demand[] | null>(() => peekShared<{ demand: Demand[] }>(DEMAND_URL)?.demand ?? null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);
  const load = useCallback(async () => {
    const seq = ++latest.current;
    try {
      const data = await sharedGet<{ demand: Demand[] }>(DEMAND_URL);
      if (seq === latest.current) { setDemand(data.demand); setError(null); }
    } catch (err) {
      if (seq === latest.current) setError(err instanceof Error ? err.message : "Could not load this demand.");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const selected = demand?.find((row) => row.id === id);
  if (selected) {
    return <DemandPanel key={selected.id} demand={selected} today={today} onChanged={load} onClose={onClose}
      onOpenTrade={onOpenTrade} onOpenSupply={onOpenSupply} onOpenDemand={onOpenDemand} />;
  }
  return (
    <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-3">
      <button type="button" onClick={onClose} className="w-fit text-[13px] hover:underline" style={{ color: "var(--bt-muted)" }}>← Bulk Trades</button>
      <ErrorText error={error} />
      <p className="text-[13px]" style={{ color: "var(--bt-muted)" }}>
        {demand && !error ? "This demand no longer exists." : error ? "" : "Loading…"}
      </p>
    </div>
  );
}
