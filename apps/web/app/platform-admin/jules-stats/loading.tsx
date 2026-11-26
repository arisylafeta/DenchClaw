import { CrmListShell, CrmLoadingState } from "@/app/components/crm/crm-list-shell";

export default function JulesStatsLoading() {
  return (
    <CrmListShell title="Jules">
      <div role="status">
        <CrmLoadingState label="Loading Jules stats…" />
      </div>
    </CrmListShell>
  );
}
