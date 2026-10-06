"use client";

import { Fragment } from "react";
import { DROP_STAGES, METRICS, dropValue, formatMetric, replayUrl, type MetricKey, type PulseWeek } from "@/lib/marketplace-pulse";

type Props = { week: PulseWeek; weekLabel: string; lastFour: PulseWeek[] };

const show = (value: number | undefined) => (value === undefined ? "–" : formatMetric("visitors", value));

/** Where buyers drop off, by stage: the selected week and the last four full weeks added up. */
export function DropOffs({ week, weekLabel, lastFour }: Props) {
  const four = (key: Parameters<typeof dropValue>[0]) => {
    const values = lastFour.map((w) => dropValue(key, w.values)).filter((v): v is number => v !== undefined);
    return values.length ? values.reduce((a, b) => a + b, 0) : undefined;
  };
  return (
    <section aria-label="Where buyers drop off" className="border" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
      <div className="flex items-baseline gap-3 border-b px-4 py-3" style={{ borderColor: "var(--bt-divider)" }}>
        <h2 className="text-[15px] font-semibold">Where buyers drop off</h2>
        <span className="text-xs" style={{ color: "var(--bt-muted)" }}>People counted once a week · recordings cover the last 30 days</span>
      </div>
      <table className="w-full text-[13px]">
        <thead>
          <tr className="text-xs" style={{ color: "var(--bt-muted)", background: "var(--bt-table-head)" }}>
            <th className="px-4 py-2 text-left font-medium">Step</th>
            <th className="px-3 py-2 text-right font-medium">Week of {weekLabel}</th>
            <th className="px-3 py-2 text-right font-medium">Last 4 weeks</th>
            <th className="px-4 py-2 text-right font-medium"><span className="sr-only">Recordings</span></th>
          </tr>
        </thead>
        <tbody>
          {DROP_STAGES.map(({ stage, rows }) => (
            <Fragment key={stage}>
              <tr className="border-t" style={{ borderColor: "var(--bt-divider)" }}>
                <th colSpan={4} scope="rowgroup" className="bt-label px-4 pb-1 pt-3 text-left">{stage}</th>
              </tr>
              {rows.map((row) => (
                <tr key={row.key} className="border-t" style={{ borderColor: "var(--bt-divider)" }}>
                  <td className="px-4 py-1.5">
                    {row.label}
                    {row.key !== "viewed_not_started" && (
                      <span className="ml-2 text-xs" style={{ color: "var(--bt-muted)" }}>{METRICS[row.key as MetricKey].hint}</span>
                    )}
                  </td>
                  <td className="bt-mono px-3 py-1.5 text-right">{show(dropValue(row.key, week.values))}</td>
                  <td className="bt-mono px-3 py-1.5 text-right">{show(four(row.key))}</td>
                  <td className="whitespace-nowrap px-4 py-1.5 text-right">
                    {row.event && (
                      <a href={replayUrl(row.event)} target="_blank" rel="noreferrer" className="text-xs" style={{ color: "var(--bt-link)" }}>
                        Watch sessions
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </section>
  );
}
