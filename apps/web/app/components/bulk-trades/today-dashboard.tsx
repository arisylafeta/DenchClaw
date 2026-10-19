"use client";

import { useEffect, useState } from "react";
import type { BulkTrade } from "@/lib/bulk-trades";
import { LIVE_STAGES } from "@/lib/bulk-trades";
import type { Demand } from "@/lib/bulk-demand";
import { shortDate } from "@/lib/bulk-trade-details";
import { ErrorText, buttonClass, buttonStyle, peekShared, sharedGet } from "./trade-ui";
import { rowFocus } from "./demand-page";

type WorkItem = {
  id: string;
  title: string;
  detail: string;
  due?: string;
  open: () => void;
};
type WorkSection = { title: string; items: WorkItem[]; inbox?: boolean };
export function TodayDashboard({
  trades,
  today,
  proposalCount,
  onOpenTrade,
  onOpenDemand,
  onOpenInbox,
  demandRevision = 0,
}: {
  trades: BulkTrade[];
  today: string;
  proposalCount: number;
  onOpenTrade: (id: string) => void;
  onOpenDemand: (id: string) => void;
  onOpenInbox: () => void;
  demandRevision?: number;
}) {
  const [demand, setDemand] = useState<Demand[]>(() => peekShared<{ demand: Demand[] }>("/api/bulk-trades/demand")?.demand ?? []);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(() => !peekShared("/api/bulk-trades/demand"));
  const [expanded, setExpanded] = useState<string[]>([]);
  useEffect(() => {
    void sharedGet<{ demand: Demand[] }>("/api/bulk-trades/demand")
      .then((data) => {
        setDemand(data.demand);
        setError(null);
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : "Could not load demand."),
      )
      .finally(() => setLoading(false));
  }, [demandRevision]);
  if (loading)
    return (
      <p className="text-[13px]" style={{ color: "var(--bt-muted)" }}>
        Loading today's work…
      </p>
    );
  const active = trades.filter(
    (trade) => trade.trade_stage !== "Done" && trade.trade_stage !== "Lost",
  );
  const sections: WorkSection[] = [
    {
      title: "Overdue next steps",
      items: active
        .filter(
          (trade) =>
            LIVE_STAGES.some((stage) => stage === trade.trade_stage) &&
            trade.next_step_due &&
            trade.next_step_due < today,
        )
        .map((trade) => ({
          id: trade.id,
          title: trade.title,
          detail: trade.next_step ?? "Next step",
          due: trade.next_step_due!,
          open: () => onOpenTrade(trade.id),
        })),
    },
    {
      title: "Qualifying questions not sent",
      items: demand
        .filter((row) => row.status === "qualifying" && !row.qualify_asked_on)
        .map((row) => ({
          id: row.id,
          title: row.buyer,
          detail: row.qualify_question ?? "Question needed",
          open: () => onOpenDemand(row.id),
        })),
    },
    { title: "Inbox proposals", inbox: true, items: [] },
    {
      title: "Trades missing a side",
      items: active
        .filter((trade) => !trade.has_seller || !trade.has_buyer)
        .map((trade) => ({
          id: trade.id,
          title: trade.title,
          detail: [
            !trade.has_seller ? "No seller yet" : "",
            !trade.has_buyer ? "No buyer yet" : "",
          ]
            .filter(Boolean)
            .join(" · "),
          open: () => onOpenTrade(trade.id),
        })),
    },
    {
      title: "Demand with missing info",
      items: demand
        .filter(
          (row) =>
            row.status !== "closed" &&
            row.missing?.some(
              (item) =>
                item !== "no supply match" && item !== "question not sent",
            ),
        )
        .map((row) => ({
          id: row.id,
          title: row.buyer,
          detail: `Missing: ${row.missing.filter((item) => item !== "no supply match" && item !== "question not sent").join(", ")}`,
          open: () => onOpenDemand(row.id),
        })),
    },
  ];
  return (
    <div className="max-w-5xl space-y-7">
      <ErrorText error={error} />
      {sections.map((section) => {
        const showingAll = expanded.includes(section.title);
        const visible = showingAll ? section.items : section.items.slice(0, 5);
        return (
          <section key={section.title} aria-label={section.title}>
            <h2
              className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-wider"
              style={{ color: "var(--bt-muted)" }}
            >
              {section.title}
              <span
                className="rounded-full border px-2 py-0.5 font-semibold tabular-nums"
                style={{ borderColor: "var(--bt-border)" }}
              >
                {section.inbox ? proposalCount : section.items.length}
              </span>
            </h2>
            {section.inbox ? (
              <div
                className="flex items-center gap-4 border-b py-3"
                style={{ borderColor: "var(--bt-divider)" }}
              >
                <p className="flex-1 text-[14px] font-semibold">
                  {proposalCount}{" "}
                  {proposalCount === 1 ? "proposal" : "proposals"} to review
                </p>
                <button
                  type="button"
                  aria-label={`${proposalCount} ${proposalCount === 1 ? "proposal" : "proposals"} to review`}
                  className={`${buttonClass} ${rowFocus}`}
                  style={buttonStyle}
                  onClick={onOpenInbox}
                >
                  Review Inbox
                </button>
              </div>
            ) : (
              <>
                {visible.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    aria-label={`${item.title} · ${item.detail}${item.due ? ` · ${shortDate(item.due)}` : ""}`}
                    className={`${rowFocus} flex w-full flex-wrap items-baseline gap-x-2 gap-y-1 border-b py-3 text-left hover:bg-[var(--bt-row-hover)]`}
                    style={{ borderColor: "var(--bt-divider)" }}
                    onClick={item.open}
                  >
                    <span className="text-[14px] font-semibold">
                      {item.title}
                    </span>
                    <span
                      className="text-[13px]"
                      style={{ color: "var(--bt-muted)" }}
                    >
                      {" "}
                      · {item.detail}
                    </span>
                    {item.due && (
                      <time
                        dateTime={item.due}
                        className="ml-auto shrink-0 text-[13px] font-medium tabular-nums"
                        style={{ color: "var(--color-warning)" }}
                      >
                        {shortDate(item.due)}
                      </time>
                    )}
                  </button>
                ))}
                {!section.items.length && (
                  <p
                    className="py-2 text-[13px]"
                    style={{ color: "var(--bt-muted)" }}
                  >
                    Nothing needs attention.
                  </p>
                )}
                {section.items.length > 5 && (
                  <button
                    type="button"
                    className={`${rowFocus} mt-2 text-[13px] font-medium underline`}
                    style={{ color: "var(--bt-link)" }}
                    onClick={() =>
                      setExpanded((current) =>
                        showingAll
                          ? current.filter((title) => title !== section.title)
                          : [...current, section.title],
                      )
                    }
                  >
                    {showingAll
                      ? "Show less"
                      : `+${section.items.length - 5} more`}
                  </button>
                )}
              </>
            )}
          </section>
        );
      })}
    </div>
  );
}
