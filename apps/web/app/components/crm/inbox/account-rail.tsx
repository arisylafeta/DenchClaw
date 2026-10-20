"use client";

import { useEffect, useState } from "react";
import styles from "./mail.module.css";

export const NO_IDENTITY = "none";
const KNOWN = ["alex", "ari", "supply", "hello", "support", "enterprise"];
type Count = { identity_key: string | null; count: number };

/** One row per mail identity plus "Other" for mail with no identity. Counts ignore the identity filter itself. */
export function AccountRail({ query, identity, showCounts, onSelect }: { query: string; identity: string; showCounts: boolean; onSelect: (identity: string) => void }) {
  const [counts, setCounts] = useState<Count[]>([]);
  const countQuery = (() => { const p = new URLSearchParams(query); p.delete("identity"); p.delete("cursor"); return p.toString(); })();
  useEffect(() => {
    if (!showCounts) { setCounts([]); return; }
    const controller = new AbortController();
    void fetch(`/api/mail/identities?${countQuery}`, { signal: controller.signal })
      .then(async (response) => { if (!response.ok) { throw new Error(`HTTP ${response.status}`); } return await response.json() as { items: Count[] }; })
      .then((body) => { if (!controller.signal.aborted) { setCounts(Array.isArray(body.items) ? body.items.filter((row) => typeof row.count === "number") : []); } })
      .catch(() => { if (!controller.signal.aborted) { setCounts([]); } });
    return () => controller.abort();
  }, [countQuery, showCounts]);
  const countOf = (key: string | null) => counts.find((row) => row.identity_key === key)?.count ?? 0;
  const extras = counts.map((row) => row.identity_key).filter((key): key is string => !!key && !KNOWN.includes(key));
  const rows: { value: string; label: string; count: number | null }[] = [
    { value: "", label: "All", count: counts.reduce((sum, row) => sum + row.count, 0) },
    ...[...KNOWN, ...extras].map((key) => ({ value: key, label: key, count: countOf(key) })),
    { value: NO_IDENTITY, label: "Other", count: countOf(null) },
  ];
  return <nav aria-label="Mail accounts" className={styles.rail}>
    {rows.map((row) => <button key={row.value || "all"} type="button" aria-current={identity === row.value ? "true" : undefined} className={styles.railItem} onClick={() => onSelect(row.value)}>
      <span className="truncate capitalize">{row.label}</span>
      {showCounts && <span className={styles.railCount}>{row.count}</span>}
    </button>)}
  </nav>;
}
