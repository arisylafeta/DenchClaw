// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ContentTab, WorkspaceTabsState } from "@/lib/workspace-tabs";
import { RightPanelContent } from "./right-panel-content";

const activeTab: ContentTab = {
  id: "workspace/work_task",
  kind: "directory",
  path: "workspace/work_task",
  title: "Work Tasks",
  preview: false,
  pinned: false,
};

const tabsState: WorkspaceTabsState = {
  contentTabs: [activeTab],
  chatTabs: [],
  activeContentId: activeTab.id,
  activeChatId: null,
};

const noop = vi.fn();

describe("RightPanelContent entry details", () => {
  it("keeps the active table visible behind a right-side details sheet", () => {
    render(
      <RightPanelContent
        tabsState={tabsState}
        activeContentTab={activeTab}
        chatPanelCollapsed={false}
        fileTreeCollapsed
        enhancedTree={[]}
        effectiveParentDir={null}
        browseDir={null}
        workspaceRoot={null}
        entryModal={{ objectName: "work_task", entryId: "REB-123" }}
        tree={[]}
        cronJobs={[]}
        onTreeNodeSelect={noop}
        onTreeRefresh={noop}
        onShowChat={noop}
        onSetFileTreeCollapsed={noop}
        onSetRightPanelCollapsed={noop}
        onActivateContent={noop}
        onCloseContent={noop}
        onCloseOtherContent={noop}
        onCloseContentToRight={noop}
        onCloseAllContent={noop}
        onCloseEntryDetail={noop}
        renderContent={() => <table aria-label="Work tasks table" />}
        renderEntryDetail={() => <div>REB-123 details</div>}
        renderPlaceholder={() => <div>Nothing open</div>}
      />,
    );

    expect(screen.getByRole("table", { name: "Work tasks table", hidden: true })).toBeInTheDocument();
    expect(screen.getByText("REB-123 details")).toBeInTheDocument();
    expect(document.querySelector('[data-slot="sheet-content"]')).toHaveAttribute(
      "data-sheet-side",
      "right",
    );
  });
});
