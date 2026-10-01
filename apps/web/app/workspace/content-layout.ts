export function contentUsesFullView(path: string | null | undefined): boolean {
  return path === "project"
    || path === "work_task"
    || path === "campaign"
    || path === "~platform-admin/listings"
    || path === "~platform-admin/stock"
    || path === "~platform-admin/payout-reviews"
    || path === "~platform-admin/battery-requests"
    || path === "~platform-admin/messages";
}

export type WorkspacePanelLayout = {
  chatPanelCollapsed: boolean;
  fileTreeCollapsed: boolean;
  rightPanelCollapsed: boolean;
};

export const FULL_VIEW_LAYOUT: WorkspacePanelLayout = {
  chatPanelCollapsed: true,
  fileTreeCollapsed: true,
  rightPanelCollapsed: false,
};
