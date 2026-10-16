"use client";

import { useEffect, useState } from "react";
import type { BulkTrade } from "@/lib/bulk-trades";
import type { Demand } from "@/lib/bulk-demand";
import { ErrorText, request } from "./trade-ui";
import { rowFocus } from "./demand-page";

export function TodayDashboard({
  trades,
  today,
  proposalCount,
  onOpenTrade,
  onOpenDemand,
  onOpenInbox,
}: {
  trades: BulkTrade[];
  today: string;
  proposalCount: number;
  onOpenTrade: (id: string) => void;
  onOpenDemand: (id: string) => void;
  onOpenInbox: () => void;
}) {
  const [demand, setDemand] = useState<Demand[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    void request<{ demand: Demand[] }>("/api/bulk-trades/demand")
      .then((data) => setDemand(data.demand))
      .catch((err) =>
        setError(err instanceof Error ? err.message : "Could not load demand."),
      )
      .finally(() => setLoading(false));
  }, []);
  if (loading)
    return (
      <p className="text-[13px]" style={{ color: "var(--bt-muted)" }}>
        Loading today's work…
      </p>
    );
  const active = trades.filter(
    (trade) => trade.trade_stage !== "Done" && trade.trade_stage !== "Lost",
  );
  const sections = [
    {
      title: "Overdue next steps",
      items: active
        .filter((trade) => trade.next_step_due && trade.next_step_due < today)
        .map((trade) => ({
          id: trade.id,
          label: `${trade.title} · ${trade.next_step ?? "Next step"} · ${trade.next_step_due}`,
          open: () => onOpenTrade(trade.id),
        })),
    },
    {
      title: "Qualifying questions not sent",
      items: demand
        .filter((row) => row.status === "qualifying" && !row.qualify_asked_on)
        .map((row) => ({
          id: row.id,
          label: `${row.buyer} · ${row.qualify_question ?? "Question needed"}`,
          open: () => onOpenDemand(row.id),
        })),
    },
    {
      title: "Inbox proposals",
      items: [
        {
          id: "inbox",
          label: `${proposalCount} proposals to review`,
          open: onOpenInbox,
        },
      ],
    },
    {
      title: "Trades missing a side",
      items: active
        .filter((trade) => !trade.has_seller || !trade.has_buyer)
        .map((trade) => ({
          id: trade.id,
          label: `${trade.title} · ${[!trade.has_seller ? "No seller yet" : "", !trade.has_buyer ? "No buyer yet" : ""].filter(Boolean).join(" · ")}`,
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
          label: `${row.buyer} · Missing: ${row.missing.filter((item) => item !== "no supply match" && item !== "question not sent").join(", ")}`,
          open: () => onOpenDemand(row.id),
        })),
    },
  ];
  return (
    <div className="max-w-5xl space-y-7">
      <ErrorText error={error} />
      {sections.map((section) => (
        <section key={section.title}>
          <h2
            className="mb-2 text-[11px] uppercase tracking-wider"
            style={{ color: "var(--bt-muted)" }}
          >
            {section.title}{" "}
            <span className="ml-2 tabular-nums">
              {section.title === "Inbox proposals"
                ? proposalCount
                : section.items.length}
            </span>
          </h2>
          {section.items.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`${rowFocus} block w-full truncate border-b py-3 text-left text-[13px] hover:bg-[var(--bt-row-hover)]`}
              style={{ borderColor: "var(--bt-divider)" }}
              title={item.label}
              onClick={item.open}
            >
              {item.label}
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
        </section>
      ))}
    </div>
  );
}
