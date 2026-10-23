"use client";

import { useState } from "react";
import type { CampaignEngagement } from "@/lib/crm-postgres/campaign-engagement";
import { buildEntryLink } from "@/lib/workspace-links";

type SortKey = "return_sessions" | "human_links_clicked" | "total_opens" | "last_opened" | "flagged_clicks" | "replied" | "person_name";

export function CampaignEngagementRanking({ rows, onNavigateEntry }: {
  rows: CampaignEngagement[];
  onNavigateEntry?: (objectName: string, entryId: string) => void;
}) {
  const [sort, setSort] = useState<SortKey>("return_sessions");
  const [notReplied, setNotReplied] = useState(false);
  const visible = rows.filter((row) => !notReplied || !row.replied).toSorted((a, b) => {
    const primary = sort === "person_name"
      ? (a.person_name || a.recipient_email).localeCompare(b.person_name || b.recipient_email)
      : sort === "last_opened" ? Date.parse(b.last_opened || "1970-01-01") - Date.parse(a.last_opened || "1970-01-01")
      : Number(b[sort]) - Number(a[sort]);
    return primary || b.return_sessions - a.return_sessions || b.human_links_clicked - a.human_links_clicked ||
      a.recipient_key.localeCompare(b.recipient_key);
  });
  const summary = [
    ["Opened", rows.filter((row) => row.total_opens > 0).length],
    ["Clicked", rows.filter((row) => row.human_links_clicked > 0 || row.flagged_clicks > 0).length],
    ["Returning readers", rows.filter((row) => row.return_sessions > 0).length],
  ] as const;

  return <section aria-label="Engagement ranking" className="border-t px-5 py-5" style={{ borderColor: "var(--color-border)", color: "var(--color-text)" }}>
    <h3 className="text-sm font-semibold">Engagement ranking</h3>
    <p className="mt-1 text-xs" style={{ color: "var(--color-text-muted)" }}>
      Email observations, not verified people or site visits (site visit unverified).
    </p>
    <dl className="my-4 flex flex-wrap gap-x-8 gap-y-3" aria-label="Campaign engagement observations">
      {summary.map(([label, value]) => <div key={label}><dt className="text-xs" style={{ color: "var(--color-text-muted)" }}>{label}</dt><dd className="text-lg font-semibold tabular-nums">{value}</dd></div>)}
    </dl>
    <div className="flex flex-wrap items-center gap-4 text-xs">
      <label className="flex items-center gap-2">Sort by
        <select value={sort} onChange={(event) => setSort(event.target.value as SortKey)} className="min-h-11 rounded border px-2" style={{ borderColor: "var(--color-border)", background: "var(--color-bg)" }}>
          <option value="return_sessions">Return sessions</option><option value="human_links_clicked">Human links clicked</option>
          <option value="total_opens">Total opens</option><option value="last_opened">Last opened</option>
          <option value="flagged_clicks">Flagged clicks</option><option value="replied">Replied</option><option value="person_name">Person</option>
        </select>
      </label>
      <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={notReplied} onChange={(event) => setNotReplied(event.target.checked)} />Not replied</label>
      <span style={{ color: "var(--color-text-muted)" }}>{visible.length} recipients</span>
    </div>
    <p className="my-3 text-xs" style={{ color: "var(--color-text-muted)" }}>
      Returns count open sessions after the first, separated by more than 10 minutes, including flagged observations. Human clicks means unflagged distinct links, not verified humans. Proxy/scanner flags are heuristic, including clicks within 5 seconds of delivery or rapid multi-link bursts. Flagged observations remain visible. Duplicate legacy snapshots are counted once when a matching provider event exists.
    </p>
    {visible.length === 0 ? <p className="text-sm" style={{ color: "var(--color-text-muted)" }}>No recipients match this ranking.</p> :
      <div className="overflow-x-auto"><table className="w-full text-left text-xs">
        <thead style={{ color: "var(--color-text-muted)" }}><tr>{["Person", "Company", "Total opens", "Flagged opens", "Return sessions", "Last opened (UTC)", "Distinct links clicked (human)", "Flagged clicks", "Replied"].map((heading) => <th key={heading} scope="col" className="whitespace-nowrap border-b px-3 py-2 font-medium" style={{ borderColor: "var(--color-border)" }}>{heading}</th>)}</tr></thead>
        <tbody>{visible.map((row) => <tr key={row.recipient_key}>
          <td className="min-w-40 px-3 py-3">{row.person_id ? <a className="font-medium underline underline-offset-2" href={buildEntryLink("people", row.person_id)} onClick={onNavigateEntry ? (event) => { event.preventDefault(); onNavigateEntry("people", row.person_id!); } : undefined}>{row.person_name || row.recipient_email}</a> : <span>{row.person_name || row.recipient_email}</span>}
            {row.person_name && <div className="mt-1 break-all" style={{ color: "var(--color-text-muted)" }}>{row.recipient_email}</div>}
            {row.likely_bot && <div className="mt-1 font-medium" title="All recorded opens and clicks are flagged as proxy/scanner observations">Likely bot</div>}
          </td>
          <td className="px-3 py-3">{row.company_name || "Not linked"}</td>
          <td className="px-3 py-3 tabular-nums">{row.total_opens}</td><td className="px-3 py-3 tabular-nums">{row.flagged_opens}</td>
          <td className="px-3 py-3 tabular-nums">{row.return_sessions}</td>
          <td className="whitespace-nowrap px-3 py-3">{row.last_opened ? <time dateTime={row.last_opened}>{new Date(row.last_opened).toISOString().replace("T", " ").slice(0, 16)}</time> : "Not observed"}</td>
          <td className="px-3 py-3 tabular-nums">{row.human_links_clicked}</td><td className="px-3 py-3 tabular-nums">{row.flagged_clicks}</td><td className="px-3 py-3">{row.replied ? "Yes" : "No"}</td>
        </tr>)}</tbody>
      </table></div>}
  </section>;
}
