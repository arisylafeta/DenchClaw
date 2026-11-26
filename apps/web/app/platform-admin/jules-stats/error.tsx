"use client";

import { CrmEmptyState, CrmListShell } from "@/app/components/crm/crm-list-shell";

export default function JulesStatsError({ reset }: { reset: () => void }) {
  return (
    <CrmListShell title="Jules">
      <CrmEmptyState
        title="Jules stats are unavailable"
        description="We couldn’t read the platform. Please try again."
        cta={
          <button
            type="button"
            onClick={reset}
            className="h-8 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-xs font-medium text-[var(--color-text)]"
          >
            Try again
          </button>
        }
      />
    </CrmListShell>
  );
}
