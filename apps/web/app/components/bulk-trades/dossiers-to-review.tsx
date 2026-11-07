"use client";

import { useEffect, useState } from "react";
import { formatDayLabel } from "../crm/format-relative-date";

type DossierToReview = {
  company_id: string;
  name: string;
  stale_since: string;
  reasons: { date: string | null; reason: string; source_id: string | null }[];
  version: number;
};

const SHOWN = 8;

/**
 * "Dossiers to review": the buyer dossiers intake has flagged since a person last looked at them.
 * Nothing here writes; opening the company and pressing Mark reviewed does. Hidden when nothing is
 * waiting, so the Today list stays the day's work rather than a standing banner.
 */
export function DossiersToReview({ onOpenCompany }: { onOpenCompany?: (id: string) => void }) {
  const [dossiers, setDossiers] = useState<DossierToReview[] | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/api/crm/buyer-dossiers")
      .then((res) => (res.ok ? res.json() : { dossiers: [] }))
      .then((data: { dossiers?: DossierToReview[] }) => { if (live) {setDossiers(data.dossiers ?? []);} })
      .catch(() => { if (live) {setDossiers([]);} });
    return () => { live = false; };
  }, []);

  if (!dossiers?.length) {return null;}
  const shown = dossiers.slice(0, SHOWN);

  return (
    <section aria-label="Dossiers to review" data-dossiers-to-review
      className="overflow-hidden rounded-xl border" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
      <header className="flex items-baseline justify-between gap-2 border-b px-4 py-3" style={{ borderColor: "var(--bt-divider)" }}>
        <h2 className="text-[15px] font-semibold">Dossiers to review</h2>
        <span className="text-[12px] tabular-nums" style={{ color: "var(--bt-text-2)" }}>
          {dossiers.length} {dossiers.length === 1 ? "buyer" : "buyers"}
        </span>
      </header>
      <ul className="divide-y divide-[var(--bt-divider)]">
        {shown.map((dossier) => {
          const reason = dossier.reasons[0];
          return (
            <li key={dossier.company_id}>
              <button type="button" onClick={() => onOpenCompany?.(dossier.company_id)} disabled={!onOpenCompany}
                className="flex w-full items-start justify-between gap-3 px-4 py-2.5 text-left text-[13px] transition-colors hover:bg-[var(--bt-row-hover)] disabled:cursor-default">
                <span className="min-w-0">
                  <span className="block truncate font-medium">{dossier.name}</span>
                  <span className="block text-[12px]" style={{ color: "var(--bt-muted)" }}>
                    {reason ? `${reason.date ? `${formatDayLabel(reason.date)}: ` : ""}${reason.reason}` : "New evidence since the last review"}
                    {dossier.reasons.length > 1 ? ` · ${dossier.reasons.length - 1} more` : ""}
                  </span>
                </span>
                <span className="shrink-0 text-[12px] tabular-nums" style={{ color: "var(--bt-amber, var(--bt-text-2))" }}>
                  since {formatDayLabel(dossier.stale_since)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {dossiers.length > shown.length && (
        <p className="border-t px-4 py-2 text-[12px]" style={{ borderColor: "var(--bt-divider)", color: "var(--bt-muted)" }}>
          and {dossiers.length - shown.length} more
        </p>
      )}
    </section>
  );
}
