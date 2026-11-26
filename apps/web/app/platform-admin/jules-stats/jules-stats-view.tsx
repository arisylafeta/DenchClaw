"use client";

import { CrmListShell } from "@/app/components/crm/crm-list-shell";
import type { FunnelRow, HealthStats, JulesStats, WindowStats } from "./metrics";

const CARD = "rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]";
const MUTED = "text-[var(--color-text-muted)]";

function pct(count: number, total: number): string {
  if (!total) {
    return "0%";
  }
  return `${Math.round((100 * count) / total)}%`;
}

function duration(seconds: number | null): string {
  if (seconds === null) {
    return "n/a";
  }
  if (seconds < 90) {
    return `${Math.round(seconds)} s`;
  }
  if (seconds < 5400) {
    return `${Math.round(seconds / 60)} min`;
  }
  return `${(seconds / 3600).toFixed(1)} h`;
}

function Metric({
  label,
  value,
  previous,
  tone,
  note,
}: {
  label: string;
  value: number | string;
  previous?: number | string;
  tone?: "warning" | "muted";
  note?: string;
}) {
  const color =
    tone === "warning" ? "var(--color-warning)" : tone === "muted" ? "var(--color-text-muted)" : "var(--color-text)";
  return (
    <div className={`${CARD} px-4 py-3`}>
      <div className={`text-[11px] uppercase tracking-wide ${MUTED}`}>{label}</div>
      <div className="mt-1 font-instrument text-2xl leading-none" style={{ color }}>
        {value}
      </div>
      {previous !== undefined && (
        <div className={`mt-1 text-[12px] ${MUTED}`}>
          {previous} in the 7 before
        </div>
      )}
      {note && <div className={`mt-1 text-[12px] ${MUTED}`}>{note}</div>}
    </div>
  );
}

function FunnelTable({ rows, totals }: { rows: FunnelRow[]; totals: WindowStats["totals"] }) {
  const columns: { key: keyof Omit<FunnelRow, "entry" | "label">; label: string }[] = [
    { key: "chats", label: "Chats" },
    { key: "priceShown", label: "Price shown" },
    { key: "emailLeft", label: "Email left" },
    { key: "readyToPublish", label: "Ready to publish" },
    { key: "published", label: "Published" },
  ];
  const cell = (row: FunnelRow, key: (typeof columns)[number]["key"]) => {
    const value = row[key];
    if (key === "chats") {
      return <span className="tabular-nums">{value}</span>;
    }
    return (
      <span className="tabular-nums">
        {value} <span className={`text-[12px] ${MUTED}`}>{pct(value, row.chats)}</span>
      </span>
    );
  };
  return (
    <div className={`${CARD} overflow-x-auto`}>
      <table className="w-full min-w-[640px] border-collapse text-[13px]">
        <thead>
          <tr className={`text-left text-[11px] uppercase tracking-wide ${MUTED}`}>
            <th className="px-4 py-2 font-normal">Entry</th>
            {columns.map((column) => (
              <th key={column.key} className="px-4 py-2 text-right font-normal">
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={columns.length + 1} className={`px-4 py-6 text-[13px] ${MUTED}`}>
                No Jules chats in the last 7 days.
              </td>
            </tr>
          )}
          {rows.map((row) => (
            <tr key={row.entry} className="border-t border-[var(--color-border)]">
              <td className="px-4 py-2" style={{ color: "var(--color-text)" }}>
                {row.label}
              </td>
              {columns.map((column) => (
                <td key={column.key} className="px-4 py-2 text-right" style={{ color: "var(--color-text)" }}>
                  {cell(row, column.key)}
                </td>
              ))}
            </tr>
          ))}
          {rows.length > 0 && (
            <tr className="border-t border-[var(--color-border)] font-medium">
              <td className="px-4 py-2">All entries</td>
              {columns.map((column) => (
                <td key={column.key} className="px-4 py-2 text-right">
                  {cell({ entry: "other", label: "All", ...totals }, column.key)}
                </td>
              ))}
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function Health({ health, previous }: { health: HealthStats; previous: HealthStats }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      <Metric
        label="Chats with no reply"
        value={health.noReply}
        previous={previous.noReply}
        tone={health.noReply > 0 ? "warning" : "muted"}
      />
      <Metric
        label="Placeholder replies"
        value={health.placeholderReplies}
        previous={previous.placeholderReplies}
        tone={health.placeholderReplies > 0 ? "warning" : "muted"}
        note="Blank or only “I've started your draft listing.”"
      />
      <Metric
        label="Failed turns"
        value={health.failedTurns}
        previous={previous.failedTurns}
        tone={health.failedTurns > 0 ? "warning" : "muted"}
      />
      <Metric
        label="First reply"
        value={`${duration(health.firstReplySeconds.p50)} / ${duration(health.firstReplySeconds.p90)}`}
        note={`p50 / p90, ${health.firstReplySeconds.answered} chats`}
      />
      <Metric
        label="Waiting on us"
        value={health.waitingOnUs}
        tone={health.waitingOnUs > 0 ? "warning" : "muted"}
        note="Sales leads whose last email is from the seller"
      />
    </div>
  );
}

function Section({ title, caption, children }: { title: string; caption?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline gap-3">
        <h2 className="text-[13px] font-medium" style={{ color: "var(--color-text)" }}>
          {title}
        </h2>
        {caption && <span className={`text-[12px] ${MUTED}`}>{caption}</span>}
      </div>
      {children}
    </section>
  );
}

export function JulesStatsView({ stats }: { stats: JulesStats }) {
  const { current, previous } = stats;
  return (
    <CrmListShell title="Jules" count={current.totals.chats}>
      <div className="space-y-6 px-6 py-5">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Metric label="Chats" value={current.totals.chats} previous={previous.totals.chats} />
          <Metric
            label="Email left"
            value={current.totals.emailLeft}
            previous={previous.totals.emailLeft}
            note={`${pct(current.totals.emailLeft, current.totals.chats)} of chats`}
          />
          <Metric
            label="Ready to publish"
            value={current.totals.readyToPublish}
            previous={previous.totals.readyToPublish}
          />
          <Metric label="Published" value={current.totals.published} previous={previous.totals.published} />
          <Metric
            label="Price shown"
            value={current.totals.priceShown}
            previous={previous.totals.priceShown}
            note="Reply quoting an amount"
          />
        </div>

        <Section title="Funnel" caption="Last 7 days, share of that entry's chats">
          <FunnelTable rows={current.funnel} totals={current.totals} />
        </Section>

        <Section title="Follow-up">
          <div className="grid gap-3 sm:grid-cols-3">
            <Metric label="Team emails" value={current.followUps.teamEmails} previous={previous.followUps.teamEmails} />
            <Metric
              label="Automatic follow-ups"
              value={current.followUps.autoFollowUps}
              previous={previous.followUps.autoFollowUps}
            />
            <Metric
              label="Seller replies"
              value={current.followUps.sellerReplies}
              previous={previous.followUps.sellerReplies}
            />
          </div>
        </Section>

        <Section title="Health" caption="Counts can overlap; chats are the last 7 days">
          <Health health={current.health} previous={previous.health} />
        </Section>

        <Section title="Lanes" caption="Chats by lane, last 7 days">
          <div className="grid gap-3 sm:grid-cols-3">
            <Metric label="Sales" value={current.lanes.sales} previous={previous.lanes.sales} />
            <Metric label="Recycling" value={current.lanes.recycling} previous={previous.lanes.recycling} />
            <Metric label="Buyer" value={current.lanes.buyer} previous={previous.lanes.buyer} />
          </div>
        </Section>

        <p className={`text-[12px] ${MUTED}`}>
          Read-only from the production platform, refreshed on load. Counts and states only.
        </p>
      </div>
    </CrmListShell>
  );
}
