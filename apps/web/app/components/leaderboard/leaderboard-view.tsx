"use client";

import { useEffect, useState } from "react";
import type { LeaderboardResult, LeaderboardRow } from "@/lib/leaderboard/query";
import { SEGMENTS } from "@/lib/leaderboard/scoring";
import { ErrorText, Modal, buttonClass, buttonStyle, darkButtonClass, darkButtonStyle, inputClass, inputStyle } from "../bulk-trades/trade-ui";
import tableStyles from "../ui/data-table.module.css";
import { TableCellContent } from "../ui/table-cell";

const PAGE_SIZE = 50;
const COLUMNS = "grid-cols-[44px_minmax(0,1.5fr)_minmax(0,1.1fr)_90px_80px_80px_100px_minmax(0,1.6fr)]";

const ROLES: Array<[string, string]> = [["", "All"], ["buyer", "Buyers"], ["supplier", "Suppliers"], ["recycler", "Recyclers"]];
const WINDOWS = [7, 30, 90];

type Segment = (typeof SEGMENTS)[number];
const SEGMENT_STYLE: Record<string, React.CSSProperties> = {
  active: { background: "var(--bt-green)", color: "var(--bt-surface)", borderColor: "var(--bt-green)" },
  rising: { background: "var(--bt-blue-bg)", color: "var(--bt-blue)", borderColor: "var(--bt-blue-border)" },
  new: { background: "var(--bt-purple-bg)", color: "var(--bt-purple)", borderColor: "var(--bt-purple-border)" },
  cooling: { background: "var(--bt-amber-bg)", color: "var(--bt-amber)", borderColor: "var(--bt-amber-border)" },
  dormant: { background: "var(--bt-divider)", color: "var(--bt-text-2)", borderColor: "var(--bt-grey-border)" },
  never_active: { background: "transparent", color: "var(--bt-muted)", borderColor: "var(--bt-border)" },
};
const SEGMENT_DOT: Record<string, string> = {
  active: "#15803d", rising: "#3b82f6", new: "#8b5cf6", cooling: "#c2410c", dormant: "#8a8a8a", never_active: "#c4c4c4",
};
const label = (value: string) => value.replace("_", " ").replace(/^./, (c) => c.toUpperCase());

function SegmentTag({ segment }: { segment: string }) {
  return <span className="whitespace-nowrap border px-2 py-0.5 text-xs font-medium" style={SEGMENT_STYLE[segment]}>{label(segment)}</span>;
}

function lastSeen(iso: string | null) {
  if (!iso) return "Never";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 60) return `${days} days ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

const actionName = (event: string) => event.replace(/^(listing|marketplace)_/, "").replace(/_/g, " ");

export function LeaderboardView({ onOpenPerson }: { onOpenPerson?: (id: string) => void }) {
  const [q, setQ] = useState("");
  const [role, setRole] = useState("buyer");
  const [window, setWindow] = useState(30);
  const [segment, setSegment] = useState("");
  const [inCrm, setInCrm] = useState(false);
  const [noOffer, setNoOffer] = useState(false);
  const [sort, setSort] = useState("score");
  const [offset, setOffset] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [data, setData] = useState<LeaderboardResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<LeaderboardRow | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ q, window: String(window), sort, limit: String(PAGE_SIZE), offset: String(offset) });
    if (role) params.set("role", role);
    if (segment) params.set("segment", segment);
    if (inCrm) params.set("inCrm", "true");
    if (noOffer) params.set("noOffer", "true");
    fetch(`/api/leaderboard?${params}`, { signal: abort.signal, cache: "no-store" })
      .then(async (response) => {
        const payload: LeaderboardResult = await response.json();
        if (!response.ok || payload.source === "error") throw new Error(payload.error || "Leaderboard unavailable");
        if (!abort.signal.aborted) setData(payload);
      })
      .catch((err) => { if (!abort.signal.aborted) setError(err instanceof Error ? err.message : "Leaderboard unavailable"); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [q, role, window, segment, inCrm, noOffer, sort, offset, attempt]);

  const change = (fn: () => void) => { fn(); setOffset(0); };
  const open = (row: LeaderboardRow) => {
    if (row.personId && onOpenPerson) { onOpenPerson(row.personId); } else { setReview(row); }
  };
  const counts = data?.counts;
  const total = counts ? Object.values(counts).reduce((a, b) => a + b, 0) : null;
  const statCells: Array<[string, string, string, string]> = [
    ["", "Everyone", total == null ? "–" : String(total), "accounts in this view"],
    ...(["active", "rising", "cooling", "dormant", "never_active"] as Segment[]).map((s): [string, string, string, string] => [
      s, label(s), counts ? String(counts[s]) : "–",
      ({ active: "using it now", rising: "picking up", cooling: "slowing down", dormant: "gone quiet", never_active: "no activity recorded" } as Record<string, string>)[s] ?? "",
    ]),
  ];
  const sortHeader = (key: string, text: string) => (
    <button type="button" onClick={() => change(() => setSort(sort === key ? `-${key}` : key))} className="text-left font-medium hover:underline">
      {text}{sort === key ? " ↓" : sort === `-${key}` ? " ↑" : ""}
    </button>
  );
  const toggle = (on: boolean, text: string, set: (v: boolean) => void) => (
    <button type="button" aria-pressed={on} onClick={() => change(() => set(!on))} className="h-8 border px-3 text-xs font-medium"
      style={on ? { background: "var(--bt-badge)", color: "var(--bt-on-badge)", borderColor: "var(--bt-badge)" } : { background: "var(--bt-surface)", borderColor: "var(--bt-border)", color: "var(--bt-text)" }}>
      {text}
    </button>
  );

  return (
    <div className="bulk-trades flex h-full flex-col">
      <header className="flex flex-col gap-3.5 border-b px-8 pt-5 pb-4" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-[26px] font-semibold tracking-[-0.01em]">Leaderboard</h1>
          <span className="text-[13px]" style={{ color: "var(--bt-muted)" }}>Who is using ReBattery, ranked by what they do · from PostHog</span>
          <span className="flex-1" />
          <div role="group" aria-label="Activity window" className="flex border" style={{ borderColor: "var(--bt-border)", background: "var(--bt-surface)" }}>
            {WINDOWS.map((days) => (
              <button key={days} type="button" aria-pressed={window === days} onClick={() => change(() => setWindow(days))} className="h-9 px-3.5 text-[13px] font-medium"
                style={window === days ? { background: "var(--bt-badge)", color: "var(--bt-on-badge)" } : { color: "var(--bt-text)" }}>
                {days} days
              </button>
            ))}
          </div>
        </div>
        <section aria-label="Activity counts" className="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-px border" style={{ borderColor: "var(--bt-border)", background: "var(--bt-border)" }}>
          {statCells.map(([key, name, value, hint]) => (
            <button key={name} type="button" onClick={() => change(() => setSegment(key))} aria-pressed={segment === key}
              className="flex flex-col gap-1 px-3.5 py-2.5 text-left hover:bg-[var(--bt-row-hover)]"
              style={{ background: segment === key ? "var(--bt-bg)" : "var(--bt-surface)" }}>
              <span className="bt-label flex items-center gap-1.5">
                {key && <span aria-hidden="true" className="inline-block h-2 w-2" style={{ background: SEGMENT_DOT[key] }} />}{name}
              </span>
              <span className="bt-mono text-[22px] font-semibold">{value}</span>
              <span className="text-xs" style={{ color: "var(--bt-muted)" }}>{hint}</span>
            </button>
          ))}
        </section>
      </header>

      <main className="flex-1 overflow-auto px-8 pb-8 pt-6">
        <div className={`${tableStyles.surface} flex flex-col gap-4`}>
          <div data-table-part="toolbar" className="flex flex-wrap items-center gap-2.5">
            <input data-table-part="search" type="search" aria-label="Search people" placeholder="Search name, email or company"
              value={q} onChange={(e) => change(() => setQ(e.target.value))} className={`${inputClass} !h-8 !w-[300px] text-xs`} style={inputStyle} />
            <div role="group" aria-label="Role" className="flex border" style={{ borderColor: "var(--bt-border)", background: "var(--bt-surface)" }}>
              {ROLES.map(([value, text]) => (
                <button key={text} type="button" aria-pressed={role === value} onClick={() => change(() => setRole(value))} className="h-8 px-3 text-xs font-medium"
                  style={role === value ? { background: "var(--bt-badge)", color: "var(--bt-on-badge)" } : { color: "var(--bt-text)" }}>
                  {text}
                </button>
              ))}
            </div>
            {toggle(noOffer, "No offer yet", setNoOffer)}
            {toggle(inCrm, "In CRM", setInCrm)}
            <span className="flex-1" />
            <span className="text-[13px]" style={{ color: "var(--bt-muted)" }}>{data ? `${data.total} people` : ""}</span>
          </div>

          <ErrorText error={error} />
          {error && <button type="button" onClick={() => setAttempt((a) => a + 1)} className={`${buttonClass} self-start`} style={buttonStyle}>Retry</button>}
          {data?.linkPending && <p className="text-[13px]" style={{ color: "var(--bt-amber)" }}>Account links pending: showing PostHog identities only, CRM matching is unavailable.</p>}

          {loading && !data ? (
            <p className="text-sm" style={{ color: "var(--bt-muted)" }}>Loading activity. The first load pulls everyone from PostHog and can take a few seconds.</p>
          ) : data && (
            <div className="border" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)", opacity: loading ? 0.6 : 1 }}>
              <div className="overflow-x-auto">
                <div className="min-w-[1040px]">
              <div data-table-part="grid-header" className={`grid ${COLUMNS} gap-4 border-b px-3 py-2 font-medium`} style={{ borderColor: "var(--bt-divider)" }}>
                <span>#</span>{sortHeader("person", "Person")}{sortHeader("company", "Company")}<span>Status</span>
                {sortHeader("score", "Score")}{sortHeader("activeDays", "Active days")}{sortHeader("lastSeen", "Last seen")}<span>What they do</span>
              </div>
              {data.rows.map((row, index) => (
                <div key={row.authUserId} data-table-part="grid-row" role="button" tabIndex={0} onClick={() => open(row)}
                  onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); open(row); } }}
                  className={`grid w-full ${COLUMNS} items-center gap-4 border-b px-3 py-2 text-left text-xs last:border-b-0 hover:bg-[var(--bt-row-hover)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--bt-text)]`}
                  style={{ borderColor: "var(--bt-divider)" }}>
                  <TableCellContent><span className="bt-mono" style={{ color: "var(--bt-muted)" }}>{offset + index + 1}</span></TableCellContent>
                  <TableCellContent>
                    <div className="min-w-0">
                      <div className="truncate text-xs font-semibold">{row.name || row.email || "Unknown account"}</div>
                      <div className="mt-0.5 truncate text-xs" style={{ color: "var(--bt-muted)" }}>
                        {[row.name ? row.email : null, !row.inCrm ? "Not in CRM" : null, row.reviewStatus === "needs_review" ? "Needs review" : null, row.emailOptedOut ? "Email opted out" : null].filter(Boolean).join(" · ")}
                      </div>
                    </div>
                  </TableCellContent>
                  <TableCellContent>
                    <div className="min-w-0">
                      <div className="truncate text-xs" style={{ color: row.company ? undefined : "var(--bt-muted)" }}>{row.company || "No company"}</div>
                      <div className="mt-0.5 text-xs capitalize" style={{ color: "var(--bt-muted)" }}>{row.role || "Unknown role"}</div>
                    </div>
                  </TableCellContent>
                  <TableCellContent><span><SegmentTag segment={row.segment} /></span></TableCellContent>
                  <TableCellContent><span className="bt-mono text-xs font-semibold" title={`Intent ${row.intentScore}, engagement ${row.engagementScore}`}>{row.score.toFixed(0)}</span></TableCellContent>
                  <TableCellContent><span className="bt-mono text-xs">{row.activeDays}</span></TableCellContent>
                  <TableCellContent><span className="text-xs" style={{ color: row.lastSeen ? undefined : "var(--bt-muted)" }}>{lastSeen(row.lastSeen)}</span></TableCellContent>
                  <TableCellContent>
                    <span className="truncate text-xs" style={{ color: "var(--bt-muted)" }}>
                      {row.topActions.slice(0, 3).map((a) => `${actionName(a.event)} ${a.count}`).join(" · ") || "No activity"}
                    </span>
                  </TableCellContent>
                </div>
              ))}
                </div>
              </div>
              {!data.rows.length && <p className="px-3 py-6 text-center text-sm" style={{ color: "var(--bt-muted)" }}>No people match these filters.</p>}
              <div data-table-part="footer" className="flex items-center gap-3 px-3 py-3 text-xs" style={{ color: "var(--bt-muted)" }}>
                <span>Showing {data.rows.length ? offset + 1 : 0}–{offset + data.rows.length} of {data.total} · updated {new Date(data.asOf).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</span>
                <span className="flex-1" />
                <button type="button" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} className={`${buttonClass} !h-8`} style={buttonStyle}>Previous</button>
                <button type="button" disabled={offset + PAGE_SIZE >= data.total} onClick={() => setOffset(offset + PAGE_SIZE)} className={`${buttonClass} !h-8`} style={buttonStyle}>Next</button>
              </div>
            </div>
          )}
        </div>
      </main>

      {review && (
        <Modal title="Account not linked to a CRM person" onClose={() => setReview(null)}
          footer={<button type="button" onClick={() => setReview(null)} className={darkButtonClass} style={darkButtonStyle}>Close</button>}>
          <p className="text-sm font-semibold">{review.name || review.email || review.authUserId}</p>
          <p className="text-sm" style={{ color: "var(--bt-muted)" }}>
            {review.role ? label(review.role) : "Unknown role"} · {label(review.reviewStatus)}
          </p>
          <p className="text-sm">No CRM person is linked to this platform account yet. Check who they are before linking; nothing is created automatically.</p>
        </Modal>
      )}
    </div>
  );
}
