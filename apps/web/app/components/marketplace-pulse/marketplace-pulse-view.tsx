"use client";

import { useCallback, useEffect, useState } from "react";
import {
  FUNNEL, METRICS, OTHER_METRICS, SCORECARD, change, formatMetric, funnel, mondayOf, totals, weekLabel,
  type MetricKey, type PulseData, type PulseWeek,
} from "@/lib/marketplace-pulse";
import { DropOffs } from "./drop-offs";
import { FollowUps, WaitingOnUs } from "./follow-ups";
import { ErrorText, buttonClass, buttonStyle, inputClass, inputStyle, request } from "../bulk-trades/trade-ui";

type Range = "last" | "current";
type FunnelRange = "week" | "four";

const shiftWeek = (weekStart: string, by: number) => {
  const day = new Date(`${weekStart}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + 7 * by);
  return day.toISOString().slice(0, 10);
};

const dateLabel = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Europe/London" });

export function MarketplacePulseView({ onOpenPerson }: { onOpenPerson: (id: string) => void }) {
  const [data, setData] = useState<PulseData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [range, setRange] = useState<Range>("last");
  const [funnelRange, setFunnelRange] = useState<FunnelRange>("week");

  const load = useCallback(async () => {
    try {
      setData(await request<PulseData>("/api/marketplace-pulse"));
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load Marketplace Pulse.");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function saveTarget(metric: MetricKey, value: number | null) {
    setSaveError(null);
    try {
      await request("/api/marketplace-pulse/targets", { method: "PUT", body: JSON.stringify({ metric, weekly_target: value }) });
      setData((current) => current && { ...current, targets: { ...current.targets, [metric]: value ?? undefined } });
    } catch (err) {
      setSaveError(`Could not save the target: ${err instanceof Error ? err.message : "unknown error"}`);
    }
  }

  const weeks = data?.weeks ?? [];
  const thisMonday = mondayOf(new Date());
  const complete = weeks.filter((w) => w.week_start < thisMonday);
  const current = weeks.find((w) => w.week_start === thisMonday);
  const selected = range === "current" ? current : complete.at(-1);
  const index = selected ? weeks.indexOf(selected) : -1;
  const partial = range === "current";
  // Compare with the calendar week before, not just the row before, in case a week is missing.
  const previous = selected ? weeks.find((w) => w.week_start === shiftWeek(selected.week_start, -1)) : undefined;
  const history = index >= 0 ? weeks.slice(Math.max(0, index - 7), index + 1) : [];
  const funnelValues = funnelRange === "four" ? totals(complete.slice(-4), FUNNEL) : selected?.values ?? {};
  const { steps, weakest } = funnel(funnelValues);
  const maxStep = Math.max(1, ...steps.map((s) => s.value));

  const tab = (value: Range, label: string) => (
    <button type="button" role="tab" aria-selected={range === value} onClick={() => setRange(value)}
      className="border-b-2 px-3.5 py-3 text-sm"
      style={range === value
        ? { borderColor: "var(--bt-text)", color: "var(--bt-text)", fontWeight: 600 }
        : { borderColor: "transparent", color: "var(--bt-muted)", fontWeight: 500 }}>
      {label}
    </button>
  );

  return (
    <div className="bulk-trades flex h-full flex-col">
      <header className="flex flex-col gap-3.5 border-b px-8 pt-5" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-[26px] font-semibold tracking-[-0.01em]">Marketplace Pulse</h1>
          <span className="text-[13px]" style={{ color: "var(--bt-muted)" }}>Where the marketplace leaks, and who to talk to</span>
          <span className="flex-1" />
          {data?.collected_at && (
            <span className="text-xs" style={{ color: "var(--bt-muted)" }}>Numbers collected {dateLabel(data.collected_at)}</span>
          )}
        </div>
        <div role="tablist" aria-label="Week" className="flex items-center gap-1">
          {tab("last", complete.length ? `Week of ${weekLabel(complete.at(-1)!.week_start)}` : "Last week")}
          {tab("current", "This week so far")}
        </div>
      </header>

      <main className="flex flex-1 flex-col gap-6 overflow-auto px-8 pb-8 pt-6">
        <ErrorText error={loadError} />
        <ErrorText error={saveError} />
        {data && !selected && (
          <p className="text-sm">
            {weeks.length ? "No numbers for this week yet. They arrive with the collector's next run." : "No numbers yet. They arrive after the collector's first run."}
          </p>
        )}
        {selected && partial && (
          <p className="text-[13px]" style={{ color: "var(--bt-muted)" }}>This week is not over, so there is no comparison or target progress yet.</p>
        )}

        {selected && (
          <section aria-label="Scorecard" className="grid grid-cols-2 border md:grid-cols-4" style={{ borderColor: "var(--bt-border)" }}>
            {SCORECARD.map((key) => (
              <ScoreCell key={key} metric={key} weeks={history} value={selected.values[key]} previous={partial ? undefined : previous?.values[key]}
                target={data?.targets[key]} showProgress={!partial} onSaveTarget={(value) => saveTarget(key, value)} />
            ))}
          </section>
        )}

        {selected && (
          <section aria-label="Funnel" className="border p-4" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
            <div className="mb-3 flex items-center gap-3">
              <h2 className="text-[15px] font-semibold">Funnel</h2>
              <span className="flex-1" />
              {(["week", "four"] as const).map((value) => (
                <button key={value} type="button" aria-pressed={funnelRange === value} onClick={() => setFunnelRange(value)}
                  className={buttonClass} style={funnelRange === value ? { ...buttonStyle, borderColor: "var(--bt-text)" } : buttonStyle}>
                  {value === "week" ? `Week of ${weekLabel(selected.week_start)}` : "Last 4 full weeks"}
                </button>
              ))}
            </div>
            <ol className="flex flex-col gap-1.5">
              {steps.map((step, i) => (
                <li key={step.key} className="grid grid-cols-[200px_1fr_70px_150px] items-center gap-3 text-[13px]">
                  <span>{METRICS[step.key].label}</span>
                  <span className="h-5" style={{ background: "var(--bt-divider)" }}>
                    <span className="block h-full" style={{ width: `${(step.value / maxStep) * 100}%`, background: i === weakest ? "var(--bt-amber)" : "var(--bt-bar)" }} />
                  </span>
                  <span className="bt-mono text-right font-semibold">{formatMetric(step.key, funnelValues[step.key])}</span>
                  <span style={{ color: i === weakest ? "var(--bt-amber)" : "var(--bt-muted)" }}>
                    {step.rate === null ? "" : `${Math.round(step.rate * 100)}% of the step above`}
                    {i === weakest && <strong> · biggest drop</strong>}
                  </span>
                </li>
              ))}
            </ol>
            <p className="mt-3 text-xs" style={{ color: "var(--bt-muted)" }}>
              People are counted once a week, so 4 weeks adds up weekly counts. Deals and paid deals come from ReBattery, not PostHog.
              PostHog has no bot filter yet, so visitors may include some bots.
            </p>
          </section>
        )}

        {selected && <DropOffs week={selected} weekLabel={weekLabel(selected.week_start)} lastFour={complete.slice(-4)} />}

        {data && !!data.waiting.length && <WaitingOnUs items={data.waiting} />}

        {data && (
          <FollowUps list={data.follow_ups} error={data.follow_up_error} sender={data.sender} onOpenPerson={onOpenPerson}
            onChange={(next) => setData((current) => current && { ...current, follow_ups: current.follow_ups.map((f) => (f.key === next.key ? next : f)) })} />
        )}

        {selected && <History weeks={history} targets={data?.targets ?? {}} />}
      </main>
    </div>
  );
}

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const max = Math.max(1, ...values);
  return (
    <svg aria-hidden="true" width={values.length * 7} height="18" className="shrink-0">
      {values.map((v, i) => (
        <rect key={i} x={i * 7} y={18 - (v / max) * 18} width="5" height={Math.max(1, (v / max) * 18)}
          fill={i === values.length - 1 ? "var(--bt-text)" : "var(--bt-border-strong)"} />
      ))}
    </svg>
  );
}

type ScoreCellProps = {
  metric: MetricKey;
  weeks: PulseWeek[];
  value: number | undefined;
  previous: number | undefined;
  target: number | undefined;
  showProgress: boolean;
  onSaveTarget: (value: number | null) => Promise<void>;
};

function ScoreCell({ metric, weeks, value, previous, target, showProgress, onSaveTarget }: ScoreCellProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const delta = change(value, previous);
  const better = METRICS[metric].lowerIsBetter ? (value ?? 0) <= target! : (value ?? 0) >= target!;
  const series = weeks.map((w) => w.values[metric]).filter((v): v is number => v !== undefined);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = draft.trim();
    await onSaveTarget(trimmed === "" ? null : Number(trimmed));
    setEditing(false);
  }

  return (
    <div className="flex flex-col gap-1 border-b border-r px-3.5 py-2.5" style={{ borderColor: "var(--bt-divider)", background: "var(--bt-surface)" }}>
      <span className="bt-label">{METRICS[metric].label}</span>
      <div className="flex items-end justify-between gap-2">
        <span className="bt-mono text-[22px] font-semibold">{formatMetric(metric, value)}</span>
        <Sparkline values={series} />
      </div>
      <span className="text-xs" style={{ color: "var(--bt-muted)" }}>
        {delta ? `${delta} vs week before · ` : ""}{METRICS[metric].hint}
      </span>
      {editing ? (
        <form onSubmit={submit} className="flex items-center gap-1.5">
          <input aria-label={`Weekly target for ${METRICS[metric].label}`} type="number" min="0" step="any" value={draft}
            onChange={(e) => setDraft(e.target.value)} className={`${inputClass} h-7 w-24`} style={inputStyle} autoFocus />
          <button type="submit" className={`${buttonClass} h-7`} style={buttonStyle}>Save</button>
          <button type="button" onClick={() => setEditing(false)} className="text-xs" style={{ color: "var(--bt-muted)" }}>Cancel</button>
        </form>
      ) : (
        <button type="button" onClick={() => { setDraft(target === undefined ? "" : String(target)); setEditing(true); }}
          className="self-start text-xs underline-offset-2 hover:underline"
          style={{ color: target === undefined || !showProgress ? "var(--bt-muted)" : better ? "var(--bt-green)" : "var(--bt-amber)" }}>
          {target === undefined ? "Set weekly target" : `Target ${formatMetric(metric, target)}${showProgress && value !== undefined && target > 0 ? ` · ${Math.round((value / target) * 100)}%` : ""}`}
        </button>
      )}
    </div>
  );
}

function History({ weeks, targets }: { weeks: PulseWeek[]; targets: Partial<Record<MetricKey, number>> }) {
  const rows = [...SCORECARD, ...OTHER_METRICS];
  return (
    <section aria-label="Weekly history" className="overflow-x-auto border" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
      <h2 className="border-b px-4 py-3 text-[15px] font-semibold" style={{ borderColor: "var(--bt-divider)" }}>Weekly history</h2>
      <table className="w-full text-[13px]">
        <thead>
          <tr className="text-xs" style={{ color: "var(--bt-muted)", background: "var(--bt-table-head)" }}>
            <th className="px-4 py-2 text-left font-medium">Week of</th>
            {weeks.map((w) => <th key={w.week_start} className="px-3 py-2 text-right font-medium">{weekLabel(w.week_start)}</th>)}
            <th className="px-4 py-2 text-right font-medium">Target</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((key) => (
            <tr key={key} className="border-t" style={{ borderColor: "var(--bt-divider)" }}>
              <td className="px-4 py-1.5">{METRICS[key].label}</td>
              {weeks.map((w) => <td key={w.week_start} className="bt-mono px-3 py-1.5 text-right">{formatMetric(key, w.values[key])}</td>)}
              <td className="bt-mono px-4 py-1.5 text-right" style={{ color: "var(--bt-muted)" }}>{targets[key] === undefined ? "" : formatMetric(key, targets[key])}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
