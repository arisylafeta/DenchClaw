"use client";

/**
 * RightPanelContent — owns the v3 right-panel layout (file tree column,
 * content tab strip, content area) and reads/writes its state via the
 * `WorkspaceTabsState` reducer.
 *
 * The actual content body is rendered by a parent-supplied `renderContent`
 * callback so the heavy `ContentRenderer` switch (and its many transitive
 * UI dependencies) can stay in `workspace-content.tsx` without forcing a
 * restructure of `ObjectView`, `DirectoryListing`, etc. for this PR.
 *
 * Internally calls `useTabContent`, which keys all fetched payloads by
 * `tab.id`. That cache is what lets users switch between content tabs
 * without re-fetching, and what removes the racing state entirely — there
 * is no separate `activePath`/`content` mutable to fall out of sync with
 * the active tab.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "../ui/context-menu";
import { FileManagerTree, type TreeNode } from "./file-manager-tree";
import { FileSearch, type SuggestItem } from "./workspace-sidebar";
import { TabIcon } from "./content-tab-icon";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "../platform-admin/ui/sheet";
import type { SearchIndexItem } from "@/lib/search-index";
import type { CronJob } from "../../types/cron";
import type {
  ContentTab,
  WorkspaceTabsState,
} from "@/lib/workspace-tabs";
import { DocumentDirtyContext } from "./document-dirty-context";
import type { SubscribeWorkspaceChanges } from "../../hooks/use-workspace-watcher";
import { useTabContent } from "../../workspace/use-tab-content";
import type { ContentState } from "../../workspace/content-state";

export type EntryModalState = {
  objectName: string;
  entryId: string;
};

export type RightPanelContentProps = {
  /** Narrow panes show files or content, never cramped side-by-side columns. */
  narrow?: boolean;
  /** Source-of-truth tabs state. */
  tabsState: WorkspaceTabsState;
  subscribeChanges?: SubscribeWorkspaceChanges;
  /** Currently-active content tab (already selected by the parent). */
  activeContentTab: ContentTab | null;

  // header controls and file tree column
  chatPanelCollapsed: boolean;
  fileTreeCollapsed: boolean;
  enhancedTree: TreeNode[];
  effectiveParentDir: string | null;
  browseDir: string | null;
  workspaceRoot: string | null;
  fileSearchFn?: (query: string, limit?: number) => SearchIndexItem[];

  // content state
  entryModal: EntryModalState | null;

  // workspace-level data
  tree: TreeNode[];
  cronJobs: CronJob[];

  // file tree handlers
  onTreeNodeSelect: (node: TreeNode) => void;
  onTreeRefresh: () => void;
  onTreeNavigateUp?: () => void;
  onTreeExternalDrop?: (node: TreeNode) => void;
  onTreeFileSearchSelect?: (item: SuggestItem) => void;
  onTreeGoHome?: () => void;
  onShowChat: () => void;
  onSetFileTreeCollapsed: (collapsed: boolean) => void;
  onSetRightPanelCollapsed: (collapsed: boolean) => void;

  // tab strip handlers
  onActivateContent: (id: string) => void;
  onCloseContent: (id: string) => void;
  onCloseOtherContent: (id: string) => void;
  onCloseContentToRight: (id: string) => void;
  onCloseAllContent: () => void;

  // upstream signals
  onDuckDBMissing?: () => void;
  /**
   * Hand the active tab's `refreshActive` callback back up to the parent so
   * upstream code (e.g. column creation, entry mutations) can force a
   * re-fetch of the cached content payload after a successful write.
   *
   * Without this wire, `useTabContent`'s cache would never be invalidated
   * for things like a newly-created field — the row data updates via the
   * separate paginated entries fetch, but the schema (fields list) stays
   * stale and new columns never render.
   */
  onRefreshActiveChange?: (refresh: () => void) => void;

  /**
   * Render the resolved content body. The parent passes its own
   * `ContentRenderer` here so it can keep its existing prop tornado without
   * forcing this component to know about ObjectView etc.
   */
  renderContent: (content: ContentState, tab: ContentTab | null) => ReactNode;
  /**
   * Render the entry-detail panel when `entryModal` is set. Same indirection
   * as `renderContent` for the same reason.
   */
  renderEntryDetail: (entry: EntryModalState) => ReactNode;
  /** Close the entry-detail sheet via its overlay or Escape key. */
  onCloseEntryDetail: () => void;

  /** Empty-state rendering when no tab is active and no entry modal. */
  renderPlaceholder: () => ReactNode;
};

export function RightPanelContent(props: RightPanelContentProps) {
  const {
    tabsState,
    narrow = false,
    activeContentTab,
    chatPanelCollapsed,
    fileTreeCollapsed,
    enhancedTree,
    effectiveParentDir,
    browseDir,
    workspaceRoot,
    fileSearchFn,
    entryModal,
    tree,
    cronJobs,
    onTreeNodeSelect,
    onTreeRefresh,
    onTreeNavigateUp,
    onTreeExternalDrop,
    onTreeFileSearchSelect,
    onTreeGoHome,
    onShowChat,
    onSetFileTreeCollapsed,
    onSetRightPanelCollapsed,
    onActivateContent,
    onCloseContent,
    onCloseOtherContent,
    onCloseContentToRight,
    onCloseAllContent,
    onDuckDBMissing,
    onRefreshActiveChange,
    renderContent,
    renderEntryDetail,
    onCloseEntryDetail,
    renderPlaceholder,
  } = props;

  const { content, refreshActive, invalidateFile, setDirty, pendingExternalUpdate, externalVersion } = useTabContent(activeContentTab, {
    tabs: tabsState.contentTabs,
    workspaceRoot,
    tree,
    cronJobs,
    onDuckDBMissing,
  });
  const reportDirty = useCallback((dirty: boolean) => {
    if (activeContentTab) setDirty(activeContentTab.id, dirty);
  }, [activeContentTab?.id, setDirty]);
  useEffect(() => props.subscribeChanges?.(invalidateFile), [props.subscribeChanges, invalidateFile]);
  const entryTriggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    onRefreshActiveChange?.(refreshActive);
  }, [refreshActive, onRefreshActiveChange]);

  const activePath = activeContentTab?.path ?? null;
  const [narrowFilesOpen, setNarrowFilesOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const filesFocusPending = useRef(false);
  const showFiles = narrow ? !activeContentTab || narrowFilesOpen : !fileTreeCollapsed;
  useEffect(() => {
    if (!narrow || !filesFocusPending.current) return;
    filesFocusPending.current = false;
    panelRef.current?.querySelector<HTMLButtonElement>(showFiles ? '[title="Hide files (⌘E)"]' : '[title="Show files (⌘E)"]')?.focus();
  }, [narrow, showFiles]);
  const hideFiles = () => {
    filesFocusPending.current = narrow && !!activeContentTab;
    if (!narrow) onSetFileTreeCollapsed(true);
    else if (!activeContentTab) onShowChat();
    else setNarrowFilesOpen(false);
  };

  return (
    <div ref={panelRef} className="flex h-full min-h-0 min-w-0 overflow-hidden">
      {showFiles && (
        <FileTreeColumn
          narrow={narrow}
          enhancedTree={enhancedTree}
          activePath={activePath}
          effectiveParentDir={effectiveParentDir}
          browseDir={browseDir}
          workspaceRoot={workspaceRoot}
          fileSearchFn={fileSearchFn}
          onTreeNodeSelect={(node) => { onTreeNodeSelect(node); if (node.type !== "folder") { filesFocusPending.current = narrow; setNarrowFilesOpen(false); } }}
          onTreeRefresh={onTreeRefresh}
          onTreeNavigateUp={onTreeNavigateUp}
          onTreeExternalDrop={onTreeExternalDrop}
          onTreeFileSearchSelect={onTreeFileSearchSelect ? (item) => { onTreeFileSearchSelect(item); filesFocusPending.current = narrow; setNarrowFilesOpen(false); } : undefined}
          onTreeGoHome={onTreeGoHome}
          onCollapse={hideFiles}
        />
      )}

      <div aria-hidden={narrow && showFiles} inert={narrow && showFiles ? true : undefined} className={`${narrow && showFiles ? "hidden" : "flex"} flex-1 flex-col min-h-0 min-w-0 overflow-hidden`}>
        <ContentTabStrip
          narrow={narrow}
          tabs={tabsState.contentTabs}
          activeContentId={tabsState.activeContentId}
          chatPanelCollapsed={chatPanelCollapsed}
          fileTreeCollapsed={!showFiles}
          onShowChat={onShowChat}
          onShowFileTree={() => { if (narrow) { filesFocusPending.current = true; setNarrowFilesOpen(true); } else onSetFileTreeCollapsed(false); }}
          onCollapseRightPanel={() => onSetRightPanelCollapsed(true)}
          onActivate={onActivateContent}
          onClose={onCloseContent}
          onCloseOthers={onCloseOtherContent}
          onCloseToRight={onCloseContentToRight}
          onCloseAll={onCloseAllContent}
        />

        {activeContentTab && content.kind !== "none" ? (
          <div className="flex-1 overflow-y-auto">
            {pendingExternalUpdate && <div role="status" className="px-4 py-2 text-sm border-b">This file changed on disk. Your unsaved edits are preserved. Saving uses the existing overwrite behavior.</div>}
            <DocumentDirtyContext.Provider value={reportDirty}>
              <div key={`${activeContentTab.id}:${externalVersion}`} className="h-full">
                {renderContent(content, activeContentTab)}
              </div>
            </DocumentDirtyContext.Provider>
          </div>
        ) : (
          <div className="flex-1 min-w-0 flex items-center justify-center">
            {renderPlaceholder()}
          </div>
        )}
      </div>

      <Sheet
        open={Boolean(entryModal)}
        onOpenChange={(open) => {
          if (!open) {onCloseEntryDetail();}
        }}
      >
        <SheetContent
          side="right"
          showCloseButton={false}
          onEscapeKeyDown={(event) => {
            // EntryDetailPanel owns Escape because it knows whether a field or
            // the add-property form is active. Prevent Radix from dismissing
            // first and bypassing that unsaved-edit guard.
            event.preventDefault();
          }}
          onOpenAutoFocus={() => {
            const activeElement = document.activeElement;
            entryTriggerRef.current =
              activeElement instanceof HTMLElement ? activeElement : null;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const trigger = entryTriggerRef.current;
            entryTriggerRef.current = null;
            if (trigger?.isConnected) {
              trigger.focus();
            }
          }}
          className="w-full max-w-none gap-0 p-0 sm:w-[42rem] sm:max-w-[42rem] lg:w-[56rem] lg:max-w-[56rem] xl:w-[64rem] xl:max-w-[64rem]"
        >
          <SheetTitle className="sr-only">
            {entryModal ? `${entryModal.objectName} details` : "Entry details"}
          </SheetTitle>
          <SheetDescription className="sr-only">
            View and edit the selected entry without leaving the current table.
          </SheetDescription>
          {entryModal ? renderEntryDetail(entryModal) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}

// ---------------------------------------------------------------------------
// File tree column
// ---------------------------------------------------------------------------

type FileTreeColumnProps = {
  narrow?: boolean;
  enhancedTree: TreeNode[];
  activePath: string | null;
  effectiveParentDir: string | null;
  browseDir: string | null;
  workspaceRoot: string | null;
  fileSearchFn?: (query: string, limit?: number) => SearchIndexItem[];
  onTreeNodeSelect: (node: TreeNode) => void;
  onTreeRefresh: () => void;
  onTreeNavigateUp?: () => void;
  onTreeExternalDrop?: (node: TreeNode) => void;
  onTreeFileSearchSelect?: (item: SuggestItem) => void;
  onTreeGoHome?: () => void;
  onCollapse: () => void;
};

const FILE_TREE_WIDTH = 240;

function FileTreeColumn({
  narrow = false,
  enhancedTree,
  activePath,
  effectiveParentDir,
  browseDir,
  workspaceRoot,
  fileSearchFn,
  onTreeNodeSelect,
  onTreeRefresh,
  onTreeNavigateUp,
  onTreeExternalDrop,
  onTreeFileSearchSelect,
  onTreeGoHome,
  onCollapse,
}: FileTreeColumnProps) {
  return (
    <div
      className={`flex flex-col min-h-0 shrink-0 border-r overflow-hidden ${narrow ? "flex-1" : ""}`}
      style={{
        width: narrow ? "100%" : FILE_TREE_WIDTH,
        minWidth: narrow ? 0 : FILE_TREE_WIDTH,
        borderColor: "var(--color-border)",
      }}
    >
      {onTreeFileSearchSelect && (
        <div className="px-2 pt-2 pb-1 shrink-0 flex items-center gap-1">
          <div className="flex-1 min-w-0">
            <FileSearch onSelect={onTreeFileSearchSelect} searchFn={fileSearchFn} />
          </div>
          <button
            type="button"
            onClick={onCollapse}
            className={`${narrow ? "min-h-11 min-w-11" : ""} p-1 rounded-md cursor-pointer shrink-0 focus-visible:outline focus-visible:outline-2`}
            style={{ color: "var(--color-text-muted)" }}
            title="Hide files (⌘E)"
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.background = "var(--color-surface-hover)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.background = "transparent";
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      )}
      {browseDir && (
        <div
          className="px-3 py-2 border-b flex items-center gap-2 shrink-0"
          style={{ borderColor: "var(--color-border)" }}
        >
          <span className="shrink-0" style={{ color: "var(--color-text-muted)" }}>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M6 14l1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
            </svg>
          </span>
          <span
            className="text-[12px] font-medium truncate flex-1 min-w-0"
            style={{ color: "var(--color-text)" }}
            title={browseDir}
          >
            {browseDir.split("/").pop() || browseDir}
          </span>
          {onTreeGoHome && (
            <button
              type="button"
              onClick={onTreeGoHome}
              className="p-1 rounded-md shrink-0 transition-colors cursor-pointer"
              style={{ color: "var(--color-text-muted)" }}
              title="Return to workspace"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                <polyline points="9 22 9 12 15 12 15 22" />
              </svg>
            </button>
          )}
        </div>
      )}
      <div className="flex-1 overflow-y-auto px-1 py-2">
        <FileManagerTree
          tree={enhancedTree}
          activePath={activePath}
          onSelect={onTreeNodeSelect}
          onRefresh={onTreeRefresh}
          parentDir={effectiveParentDir}
          onNavigateUp={onTreeNavigateUp}
          browseDir={browseDir}
          workspaceRoot={workspaceRoot}
          onExternalDrop={onTreeExternalDrop}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab strip
// ---------------------------------------------------------------------------

type ContentTabStripProps = {
  narrow?: boolean;
  tabs: ContentTab[];
  activeContentId: string | null;
  chatPanelCollapsed: boolean;
  fileTreeCollapsed: boolean;
  onShowChat: () => void;
  onShowFileTree: () => void;
  onCollapseRightPanel: () => void;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onCloseOthers: (id: string) => void;
  onCloseToRight: (id: string) => void;
  onCloseAll: () => void;
};

function ContentTabStrip({
  narrow = false,
  tabs,
  activeContentId,
  chatPanelCollapsed,
  fileTreeCollapsed,
  onShowChat,
  onShowFileTree,
  onCollapseRightPanel,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseToRight,
  onCloseAll,
}: ContentTabStripProps) {
  const handleClose = useCallback(
    (e: React.MouseEvent, id: string) => {
      e.stopPropagation();
      onClose(id);
    },
    [onClose],
  );

  return (
    <div
      className={`flex items-center ${narrow ? "min-h-11" : "h-10"} shrink-0 border-b min-w-0`}
      style={{ borderColor: "var(--color-border)" }}
    >
      {!narrow && <button
        type="button"
        onClick={onCollapseRightPanel}
        className="p-1.5 ml-2 rounded-md cursor-pointer shrink-0"
        style={{ color: "var(--color-text-muted)" }}
        title="Hide right panel (⌘⇧B)"
        aria-label="Hide right panel"
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLElement).style.background = "var(--color-surface-hover)";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLElement).style.background = "transparent";
        }}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <rect width="18" height="18" x="3" y="3" rx="2" />
          <path d="M15 3v18" />
        </svg>
      </button>}
      <div className="no-scrollbar flex-1 flex items-center gap-1 px-2 min-w-0 h-full overflow-x-auto">
        {chatPanelCollapsed && (
          <button
            id="workspace-show-chat"
            type="button"
            onClick={onShowChat}
            className={`${narrow ? "min-h-11 min-w-11" : ""} flex items-center justify-center gap-1.5 px-2 py-1 rounded-md cursor-pointer shrink-0 text-[12px] font-medium focus-visible:outline focus-visible:outline-2`}
            style={{ color: "var(--color-text-muted)" }}
            title="Show chat"
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.background = "var(--color-surface-hover)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.background = "transparent";
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z" />
            </svg>
            Chat
          </button>
        )}
        {fileTreeCollapsed && (
          <button
            type="button"
            onClick={onShowFileTree}
            className={`${narrow ? "min-h-11 min-w-11" : ""} flex items-center justify-center gap-1.5 px-2 py-1 rounded-md cursor-pointer shrink-0 text-[12px] font-medium focus-visible:outline focus-visible:outline-2`}
            style={{ color: "var(--color-text-muted)" }}
            title="Show files (⌘E)"
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.background = "var(--color-surface-hover)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.background = "transparent";
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M4 4h5l2 2h9a1 1 0 0 1 1 1v11a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" />
            </svg>
            <span className={narrow ? "" : "sr-only"}>Files</span>
          </button>
        )}
        {tabs.map((tab, tabIdx) => {
          const isActive = tab.id === activeContentId;
          const hasTabsToRight = tabIdx < tabs.length - 1;
          const hasOtherTabs = tabs.length > 1;
          const truncatedTitle = tab.title.length > 24 ? tab.title.slice(0, 22) + "…" : tab.title;
          return (
            <ContextMenu key={tab.id}>
              <ContextMenuTrigger asChild>
                <div
                  className="flex items-center rounded-md shrink-0"
                  style={{ background: isActive ? "var(--color-surface-hover)" : "transparent" }}
                >
                  <button
                    type="button"
                    onClick={() => onActivate(tab.id)}
                    aria-current={isActive ? "page" : undefined}
                    aria-label={`Open ${tab.title}`}
                    className={`${narrow ? "min-h-11" : ""} flex items-center gap-1.5 pl-2 pr-1 py-1 text-[12px] font-medium transition-colors cursor-pointer focus-visible:outline focus-visible:outline-2`}
                    style={{
                      color: isActive ? "var(--color-text)" : "var(--color-text-muted)",
                      fontStyle: tab.preview ? "italic" : "normal",
                    }}
                    title={tab.title}
                  >
                    <span className="shrink-0" style={{ opacity: isActive ? 1 : 0.8 }}>
                      <TabIcon tab={tab} />
                    </span>
                    <span>{truncatedTitle}</span>
                  </button>
                  <button
                    type="button"
                    onClick={(e) => handleClose(e, tab.id)}
                    aria-label={`Close ${tab.title}`}
                    className={`${narrow ? "min-h-11 min-w-11 flex items-center justify-center" : ""} p-0.5 rounded-md mr-0.5 cursor-pointer focus-visible:outline focus-visible:outline-2`}
                    style={{ color: "var(--color-text-muted)" }}
                    title="Close tab"
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLElement).style.background = "var(--color-border)";
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLElement).style.background = "transparent";
                    }}
                  >
                    <svg
                      width="11"
                      height="11"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M18 6 6 18" />
                      <path d="m6 6 12 12" />
                    </svg>
                  </button>
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem onSelect={() => onClose(tab.id)}>Close</ContextMenuItem>
                <ContextMenuItem
                  onSelect={() => onCloseOthers(tab.id)}
                  disabled={!hasOtherTabs}
                >
                  Close other tabs
                </ContextMenuItem>
                <ContextMenuItem
                  onSelect={() => onCloseToRight(tab.id)}
                  disabled={!hasTabsToRight}
                >
                  Close tabs to the right
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={onCloseAll}>Close all tabs</ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          );
        })}
      </div>
    </div>
  );
}
