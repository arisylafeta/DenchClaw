// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function rightPanelElement(
  entryModal: { objectName: string; entryId: string } | null,
  onCloseEntryDetail = vi.fn(),
) {
  return (
    <RightPanelContent
      tabsState={tabsState}
      activeContentTab={activeTab}
      chatPanelCollapsed={false}
      fileTreeCollapsed
      enhancedTree={[]}
      effectiveParentDir={null}
      browseDir={null}
      workspaceRoot={null}
      entryModal={entryModal}
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
      onCloseEntryDetail={onCloseEntryDetail}
      renderContent={() => (
        <>
          <button type="button">Open REB-123</button>
          <table aria-label="Work tasks table" />
        </>
      )}
      renderEntryDetail={() => <div>REB-123 details</div>}
      renderPlaceholder={() => <div>Nothing open</div>}
    />
  );
}

function renderRightPanel(
  entryModal: { objectName: string; entryId: string } | null,
  onCloseEntryDetail = vi.fn(),
) {
  return render(rightPanelElement(entryModal, onCloseEntryDetail));
}

describe("RightPanelContent entry details", () => {
  it("keeps the active table visible behind a right-side details sheet", () => {
    renderRightPanel({ objectName: "work_task", entryId: "REB-123" });

    expect(screen.getByRole("table", { name: "Work tasks table", hidden: true })).toBeInTheDocument();
    expect(screen.getByText("REB-123 details")).toBeInTheDocument();
    expect(document.querySelector('[data-slot="sheet-content"]')).toHaveAttribute(
      "data-sheet-side",
      "right",
    );
  });

  it("delegates Escape handling to the entry detail so active edits can keep the sheet open", () => {
    const onCloseEntryDetail = vi.fn();
    renderRightPanel(
      { objectName: "work_task", entryId: "REB-123" },
      onCloseEntryDetail,
    );

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onCloseEntryDetail).not.toHaveBeenCalled();
    expect(screen.getByText("REB-123 details")).toBeInTheDocument();
  });

  it("returns focus to the row control after the details sheet closes", async () => {
    const view = renderRightPanel(null);
    const trigger = screen.getByRole("button", { name: "Open REB-123" });
    trigger.focus();

    view.rerender(
      rightPanelElement({ objectName: "work_task", entryId: "REB-123" }),
    );

    await waitFor(() => expect(screen.getByText("REB-123 details")).toBeInTheDocument());

    view.rerender(rightPanelElement(null));

    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
