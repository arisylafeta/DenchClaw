import { CrmListShell } from "@/app/components/crm/crm-list-shell";
import { COHORT_STEP_KEYS } from "./metrics";
import type { CohortFunnel, CohortStepKey, EntryCohort, HealthStats, JulesStats } from "./metrics";

const CARD = "rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]";
const MUTED = "text-[var(--color-text-muted)]";

/** Short column names for the per-entry table. */
const STEP_SHORT: Record<CohortStepKey, string> = {
  started: "Started",
  named: "Named lot",
  priced: "Price",
  email: "Email",
  ready: "Ready",
  published: "Published",
};

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

/**
 * The cohort funnel: every sales chat started in the window, followed in order. Bars are
 * share of started chats, so they only ever get shorter, and the drop between steps is
 * written between them. The biggest single drop carries the accent.
 */
function FunnelCard({ funnel }: { funnel: CohortFunnel }) {
  if (funnel.started === 0) {
    return (
      <div className={`${CARD} px-4 py-6 text-[13px] ${MUTED}`}>No sales chats started in the last 7 days.</div>
    );
  }
  const biggest = funnel.biggestDrop;
  // Some prices come from the reply text because no price event was recorded for them.
  // Recorded events only start on 27 Nov, so say so rather than imply full coverage.
  const priceFromText = funnel.pricedFromText > 0;

  return (
    <div className={`${CARD} px-4 py-4`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-[13px]" style={{ color: "var(--color-text)" }}>
          {biggest ? (
            <>
              <span className="font-medium">Biggest loss:</span> {Math.round(biggest.lostShare * 100)}% {biggest.label}{" "}
              <span className={MUTED}>({biggest.lost} chats)</span>
            </>
          ) : (
            "Every chat reached the last step."
          )}
        </p>
        <span className={`text-[12px] ${MUTED}`}>{funnel.started} sales chats started</span>
      </div>

      <ol className="mt-4 space-y-0">
        {funnel.steps.map((step, index) => {
          const next = funnel.steps[index + 1];
          const isBiggestTarget = biggest?.to === step.key;
          return (
            <li key={step.key}>
              <div className="grid grid-cols-[6.75rem_minmax(0,1fr)_4.5rem] items-center gap-x-3">
                <span className="text-[12px] leading-snug" style={{ color: "var(--color-text)" }}>
                  {step.label}
                  {step.key === "priced" && priceFromText && (
                    <span className={`ml-1 whitespace-nowrap text-[10px] ${MUTED}`}>events since 27 Nov</span>
                  )}
                </span>
                <div
                  className="h-2 overflow-hidden rounded-full"
                  style={{ background: "var(--color-border-strong)" }}
                  aria-hidden
                >
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${step.count ? Math.max(step.share * 100, 1.5) : 0}%`,
                      background: isBiggestTarget ? "var(--color-accent-fill)" : "var(--color-text)",
                      opacity: isBiggestTarget ? 1 : 0.78,
                    }}
                  />
                </div>
                <span className="text-right text-[12px] tabular-nums" style={{ color: "var(--color-text)" }}>
                  {step.count}
                  <span className={`ml-1 ${MUTED}`}>{Math.round(step.share * 100)}%</span>
                </span>
              </div>
              {next && next.lost > 0 && (
                <div className="grid grid-cols-[6.75rem_minmax(0,1fr)_4.5rem] items-center gap-x-3">
                  <span aria-hidden />
                  <span
                    className="flex items-center gap-1.5 py-1 text-[11px] leading-none"
                    style={{ color: "var(--color-text-muted)" }}
                  >
                    <span aria-hidden className="h-2.5 w-px" style={{ background: "var(--color-border-strong)" }} />
                    <span className="tabular-nums">
                      −{next.lost} · {Math.round(next.lostShare * 100)}% lost
                    </span>
                    {biggest?.to === next.key && (
                      <span
                        className="rounded px-1.5 py-0.5 text-[10px] font-medium"
                        style={{ background: "var(--color-accent-fill)", color: "var(--color-accent-foreground)" }}
                      >
                        Biggest loss
                      </span>
                    )}
                  </span>
                </div>
              )}
              {next && next.lost === 0 && <div className="grid h-2 grid-cols-[6.75rem_minmax(0,1fr)_4.5rem] gap-x-3" aria-hidden>
                <span />
              </div>}
            </li>
          );
        })}
      </ol>

      {(priceFromText || funnel.emailBeforePrice > 0) && (
        <div
          className={`mt-3 space-y-1 border-t pt-2 text-[11px] leading-relaxed ${MUTED}`}
          style={{ borderColor: "var(--color-border)" }}
        >
          {priceFromText && (
            <p>
              A price counts from a recorded price event, or from a reply quoting an amount when no event exists.
              Price events only exist from 27 Nov, so some chats have no event to count.
            </p>
          )}
          {funnel.emailBeforePrice > 0 && (
            <p>
              {funnel.emailBeforePrice} chats reached contact details before any price was counted, so the real
              order is looser than these bars.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** The step that loses the most chats for one entry, and what share of the step before it that is. */
function worstStep(row: EntryCohort): { key: CohortStepKey; share: number } | null {
  let worst: { key: CohortStepKey; share: number; lost: number } | null = null;
  for (let index = 1; index < row.counts.length; index += 1) {
    const previous = row.counts[index - 1];
    const lost = previous - row.counts[index];
    if (lost > 0 && (!worst || lost > worst.lost)) {
      worst = { key: COHORT_STEP_KEYS[index], share: previous ? lost / previous : 0, lost };
    }
  }
  return worst ? { key: worst.key, share: worst.share } : null;
}

function EntryCohortTable({ rows }: { rows: EntryCohort[] }) {
  return (
    <div className={`${CARD} overflow-x-auto`}>
      <table className="w-full min-w-[680px] border-collapse text-[13px]">
        <thead>
          <tr className={`text-left text-[11px] uppercase tracking-wide ${MUTED}`}>
            <th className="px-4 py-2 font-normal">Entry</th>
            {COHORT_STEP_KEYS.map((key) => (
              <th key={key} className="px-4 py-2 text-right font-normal">
                {STEP_SHORT[key]}
              </th>
            ))}
            <th className="px-4 py-2 text-right font-normal">Most lost at</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={COHORT_STEP_KEYS.length + 2} className={`px-4 py-6 text-[13px] ${MUTED}`}>
                No sales chats in the last 7 days.
              </td>
            </tr>
          )}
          {rows.map((row) => {
            const worst = worstStep(row);
            return (
              <tr key={row.entry} className="border-t border-[var(--color-border)]">
                <td className="px-4 py-2" style={{ color: "var(--color-text)" }}>
                  {row.label}
                </td>
                {row.counts.map((count, index) => (
                  <td
                    key={COHORT_STEP_KEYS[index]}
                    className="px-4 py-2 text-right tabular-nums"
                    style={{ color: "var(--color-text)" }}
                  >
                    {count} <span className={`text-[12px] ${MUTED}`}>{pct(count, row.started)}</span>
                  </td>
                ))}
                <td className="px-4 py-2 text-right text-[12px]" style={{ color: "var(--color-text)" }}>
                  {worst ? (
                    <>
                      {STEP_SHORT[worst.key]} <span className={MUTED}>{Math.round(worst.share * 100)}%</span>
                    </>
                  ) : (
                    <span className={MUTED}>none</span>
                  )}
                </td>
              </tr>
            );
          })}
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
        note="Sales leads whose last email is the seller’s, with no reply from us after it"
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
        <Section title="Funnel" caption="Sales chats started in the last 7 days, in order">
          <div className="space-y-3">
            <FunnelCard funnel={current.cohort} />
            <EntryCohortTable rows={current.cohort.byEntry} />
          </div>
        </Section>

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
            note="Text match for an amount in a seller chat"
          />
        </div>

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
