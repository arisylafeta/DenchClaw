"use client";

import { CrmEmptyState, CrmListShell } from "@/app/components/crm/crm-list-shell";

export default function BatteryRequestsError({ reset }: { reset: () => void }) {
  return (
    <CrmListShell title="Battery requests">
      <CrmEmptyState
        title="Battery requests are unavailable"
        description="We couldn’t load the requests. Please try again."
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
