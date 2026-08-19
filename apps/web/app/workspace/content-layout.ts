export function contentUsesFullView(path: string | null | undefined): boolean {
  return path === "project"
    || path === "work_task"
    || path === "~platform-admin/payout-reviews";
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
