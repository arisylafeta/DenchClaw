"use client";

import { useCallback, useEffect, useState } from "react";
import { todayInLondon, type TradeOwner } from "@/lib/bulk-trades";
import { STAGES, STAGE_HINT, type Dismantler, type DismantlerPatch, type Stage } from "@/lib/dismantlers";
import { ErrorText, buttonClass, buttonStyle, request } from "../bulk-trades/trade-ui";
import { AddDismantlerDialog, ImportDialog, OutreachDialog, ParkDialog } from "./dismantler-dialogs";
import { DismantlerPage } from "./dismantler-page";
import { DismantlersBoard } from "./dismantlers-board";
import { DismantlersList } from "./dismantlers-list";
import { StageDot, dismantlerUrl } from "./dismantler-ui";

type Mode = "list" | "board";
const MODE_KEY = "dismantlers:view";

function storedMode(): Mode {
  try {
    return window.localStorage.getItem(MODE_KEY) === "board" ? "board" : "list";
  } catch {
    return "list";
  }
}

export function DismantlersView() {
  const [mode, setMode] = useState<Mode>("list");
  const [dismantlers, setDismantlers] = useState<Dismantler[]>([]);
  const [owners, setOwners] = useState<TradeOwner[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [outreach, setOutreach] = useState<Dismantler[] | null>(null);
  const [parking, setParking] = useState<Dismantler | null>(null);
  const today = todayInLondon();

  useEffect(() => setMode(storedMode()), []);

  const load = useCallback(async () => {
    try {
      const data = await request<{ dismantlers: Dismantler[]; owners: TradeOwner[] }>("/api/dismantlers");
      setDismantlers(data.dismantlers);
      setOwners(data.owners);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load dismantlers.");
    }
    setLoaded(true);
  }, []);

  useEffect(() => { void load(); }, [load]);

  function switchMode(next: Mode) {
    setMode(next);
    try { window.localStorage.setItem(MODE_KEY, next); } catch { /* per-viewer convenience only */ }
  }

  const replace = useCallback((saved: Dismantler) =>
    setDismantlers((current) => current.map((candidate) => (candidate.id === saved.id ? saved : candidate))), []);

  async function patch(d: Dismantler, change: DismantlerPatch) {
    setActionError(null);
    replace({ ...d, ...change } as Dismantler);
    try {
      const { dismantler } = await request<{ dismantler: Dismantler }>(dismantlerUrl(d.id), { method: "PATCH", body: JSON.stringify(change) });
      replace(dismantler);
    } catch (err) {
      replace(d);
      setActionError(`Could not update ${d.name}: ${err instanceof Error ? err.message : "unknown error"}`);
    }
  }

  /** Parking asks why first; every other move saves straight away. */
  function move(d: Dismantler, stage: Stage) {
    if (stage === d.stage) return;
    if (stage === "Parked") setParking(d);
    else void patch(d, { stage });
  }

  if (openId) {
    return (
      <div className="bulk-trades h-full">
        <DismantlerPage
          key={openId}
          id={openId}
          owners={owners}
          today={today}
          onBack={() => { setOpenId(null); void load(); }}
          onSaved={replace}
        />
      </div>
    );
  }

  const counts = Object.fromEntries(STAGES.map((stage) => [stage, dismantlers.filter((d) => d.stage === stage).length])) as Record<Stage, number>;
  const inPlay = counts.Contacted + counts.Onboarding + counts.Live + counts.Syncing;
  const tab = (value: Mode, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={mode === value}
      onClick={() => switchMode(value)}
      className="border-b-2 px-3.5 py-3 text-sm"
      style={mode === value
        ? { borderColor: "var(--bt-text)", color: "var(--bt-text)", fontWeight: 600 }
        : { borderColor: "transparent", color: "var(--bt-muted)", fontWeight: 500 }}
    >
      {label}
    </button>
  );

  return (
    <div className="bulk-trades flex h-full flex-col">
      <header className="flex flex-col gap-3.5 border-b px-8 pt-5" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-[26px] font-semibold tracking-[-0.01em]">Dismantlers</h1>
          <span className="text-[13px]" style={{ color: "var(--bt-muted)" }}>ATFs, breakers and dismantlers supplying through ReBattery</span>
          <span className="flex-1" />
          <button type="button" onClick={() => setImporting(true)} className={buttonClass} style={buttonStyle}>Import a list</button>
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="flex h-9 items-center gap-1.5 border px-3.5 text-[13px] font-medium hover:bg-[var(--bt-accent-hover)]"
            style={{ background: "var(--bt-accent)", borderColor: "var(--bt-accent)", color: "var(--bt-on-accent)" }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
            Add dismantler
          </button>
        </div>

        <nav aria-label="Journey" className="grid grid-cols-3 border md:grid-cols-6" style={{ borderColor: "var(--bt-border)" }}>
          {STAGES.map((stage) => (
            <div key={stage} className="flex flex-col gap-1 border-r px-3.5 py-2.5 last:border-r-0"
              style={{ borderColor: "var(--bt-divider)", background: stage === "Parked" ? "var(--bt-bg)" : "var(--bt-surface)" }}>
              <span className="bt-label flex items-center gap-2"><StageDot stage={stage} />{stage}</span>
              <span className="bt-mono text-[22px] font-semibold">{counts[stage]}</span>
              <span className="text-xs" style={{ color: "var(--bt-muted)" }}>{STAGE_HINT[stage]}</span>
            </div>
          ))}
        </nav>

        <div role="tablist" aria-label="Views" className="flex items-center gap-1">
          {tab("list", "List")}
          {tab("board", "Board")}
          <span className="flex-1" />
          <span className="pb-2 text-[13px]" style={{ color: "var(--bt-muted)" }}>
            {mode === "list" ? `${inPlay} in play · sorted by what needs you first` : "Drag a card, or use its arrow to move it one stage on"}
          </span>
        </div>
      </header>

      <main className="flex-1 overflow-auto px-8 pb-8 pt-6">
        <ErrorText error={loadError} />
        <ErrorText error={actionError} />
        {loaded && !loadError && !dismantlers.length ? (
          <div className="mx-auto mt-10 flex max-w-md flex-col items-center gap-3 text-center">
            <p className="text-sm">No dismantlers yet. Add one, or import a list of the ones you know about.</p>
            <div className="flex gap-2">
              <button type="button" onClick={() => setImporting(true)} className={buttonClass} style={buttonStyle}>Import a list</button>
              <button type="button" onClick={() => setAdding(true)} className={buttonClass} style={buttonStyle}>Add dismantler</button>
            </div>
          </div>
        ) : mode === "list" ? (
          <DismantlersList
            dismantlers={dismantlers}
            today={today}
            onOpen={(d) => setOpenId(d.id)}
            onStartOutreach={setOutreach}
            onShowBoard={() => switchMode("board")}
          />
        ) : (
          <DismantlersBoard
            dismantlers={dismantlers}
            today={today}
            onOpen={(d) => setOpenId(d.id)}
            onMove={move}
            onShowList={() => switchMode("list")}
          />
        )}
      </main>

      {adding && (
        <AddDismantlerDialog
          owners={owners}
          today={today}
          onClose={() => setAdding(false)}
          onAdded={(d) => { setDismantlers((current) => [...current, d]); setAdding(false); setOpenId(d.id); }}
        />
      )}
      {importing && <ImportDialog onClose={() => setImporting(false)} onImported={() => { setImporting(false); void load(); }} />}
      {outreach && (
        <OutreachDialog
          batch={outreach}
          today={today}
          onClose={() => setOutreach(null)}
          onDone={(saved) => { saved.forEach(replace); setOutreach(null); }}
        />
      )}
      {parking && (
        <ParkDialog
          dismantler={parking}
          onClose={() => setParking(null)}
          onSave={async (change) => { await patch(parking, { stage: "Parked", ...change }); setParking(null); }}
        />
      )}
    </div>
  );
}
