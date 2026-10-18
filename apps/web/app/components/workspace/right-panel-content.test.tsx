// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ContentTab, WorkspaceTabsState } from "@/lib/workspace-tabs";
import { RightPanelContent } from "./right-panel-content";
import { cloneElement, useState } from "react";
import { useDocumentDirty } from "./document-dirty-context";
import type { WorkspaceFileChange } from "../../hooks/use-workspace-watcher";

afterEach(() => vi.unstubAllGlobals());

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

function SyntheticEditor({ body }: { body: string }) {
  const [text, setText] = useState(body);
  const [dirty, setDirty] = useState(false);
  useDocumentDirty(dirty);
  return <><input aria-label="document" value={text} onChange={event => { setText(event.target.value); setDirty(true); }} /><button onClick={() => setDirty(false)}>Saved clean</button></>;
}

it("routes SSE into clean editor reload, preserves dirty input, and clears the pending notice after save", async () => {
  const tab: ContentTab = { ...activeTab, id: "report.md", path: "report.md", title: "report.md", kind: "document" };
  let listener: ((event: WorkspaceFileChange) => void) | undefined;
  let disk = "original";
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ content: disk, type: "markdown" })));
  render(cloneElement(rightPanelElement(null), {
    tabsState: { ...tabsState, contentTabs: [tab], activeContentId: tab.id },
    activeContentTab: tab,
    workspaceRoot: "/synthetic/workspace",
    subscribeChanges: (next: (event: WorkspaceFileChange) => void) => { listener = next; return () => { listener = undefined; }; },
    renderContent: (content: import("../../workspace/content-state").ContentState) => content.kind === "document" ? <SyntheticEditor body={content.data.content} /> : <div>Loading</div>,
  }));
  await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("original"));
  const event = { type: "change", root: "/synthetic/workspace", path: "report.md" };
  disk = "external clean";
  act(() => listener!(event));
  await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("external clean"));
  const editor = screen.getByRole("textbox");
  fireEvent.change(editor, { target: { value: "unsaved local edits" } });
  disk = "external dirty";
  act(() => listener!(event));
  expect(screen.getByRole("status")).toHaveTextContent("unsaved edits are preserved");
  expect(screen.getByRole("textbox")).toBe(editor);
  expect(editor).toHaveValue("unsaved local edits");
  fireEvent.click(screen.getByRole("button", { name: "Saved clean" }));
  await waitFor(() => expect(screen.queryByText(/unsaved edits are preserved/)).not.toBeInTheDocument());
  disk = "next clean update";
  act(() => listener!(event));
  await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("next clean update"));
});

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
