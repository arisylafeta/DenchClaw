import { CrmListShell, CrmLoadingState } from "@/app/components/crm/crm-list-shell";

export default function BatteryRequestsLoading() {
  return (
    <CrmListShell title="Battery requests">
      <div role="status">
        <CrmLoadingState label="Loading battery requests…" />
      </div>
    </CrmListShell>
  );
}
