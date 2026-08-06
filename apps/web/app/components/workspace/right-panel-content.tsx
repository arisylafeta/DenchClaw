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

import { useCallback, useEffect, type ReactNode } from "react";
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
import type { SearchIndexItem } from "@/lib/search-index";
import type { CronJob } from "../../types/cron";
import type {
  ContentTab,
  WorkspaceTabsState,
} from "@/lib/workspace-tabs";
import { useTabContent } from "../../workspace/use-tab-content";
import type { ContentState } from "../../workspace/content-state";

export type EntryModalState = {
  objectName: string;
  entryId: string;
};

export type RightPanelContentProps = {
  /** Source-of-truth tabs state. */
  tabsState: WorkspaceTabsState;
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

  /** Empty-state rendering when no tab is active and no entry modal. */
  renderPlaceholder: () => ReactNode;
};

export function RightPanelContent(props: RightPanelContentProps) {
  const {
    tabsState,
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
    renderPlaceholder,
  } = props;

  const { content, refreshActive } = useTabContent(activeContentTab, {
    tree,
    cronJobs,
    onDuckDBMissing,
  });

  useEffect(() => {
    onRefreshActiveChange?.(refreshActive);
  }, [refreshActive, onRefreshActiveChange]);

  const activePath = activeContentTab?.path ?? null;

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      {!fileTreeCollapsed && (
        <FileTreeColumn
          enhancedTree={enhancedTree}
          activePath={activePath}
          effectiveParentDir={effectiveParentDir}
          browseDir={browseDir}
          workspaceRoot={workspaceRoot}
          fileSearchFn={fileSearchFn}
          onTreeNodeSelect={onTreeNodeSelect}
          onTreeRefresh={onTreeRefresh}
          onTreeNavigateUp={onTreeNavigateUp}
          onTreeExternalDrop={onTreeExternalDrop}
          onTreeFileSearchSelect={onTreeFileSearchSelect}
          onTreeGoHome={onTreeGoHome}
          onCollapse={() => onSetFileTreeCollapsed(true)}
        />
      )}

      <div className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden">
        <ContentTabStrip
          tabs={tabsState.contentTabs}
          activeContentId={tabsState.activeContentId}
          chatPanelCollapsed={chatPanelCollapsed}
          fileTreeCollapsed={fileTreeCollapsed}
          onShowChat={onShowChat}
          onShowFileTree={() => onSetFileTreeCollapsed(false)}
          onCollapseRightPanel={() => onSetRightPanelCollapsed(true)}
          onActivate={onActivateContent}
          onClose={onCloseContent}
          onCloseOthers={onCloseOtherContent}
          onCloseToRight={onCloseContentToRight}
          onCloseAll={onCloseAllContent}
        />

        {entryModal ? (
          <div className="flex-1 min-h-0 overflow-hidden">{renderEntryDetail(entryModal)}</div>
        ) : activeContentTab && content.kind !== "none" ? (
          <div className="flex-1 overflow-y-auto">
            {renderContent(content, activeContentTab)}
          </div>
        ) : (
          <div className="flex-1 min-w-0 flex items-center justify-center">
            {renderPlaceholder()}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// File tree column
// ---------------------------------------------------------------------------

type FileTreeColumnProps = {
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
      className="flex flex-col min-h-0 shrink-0 border-r overflow-hidden"
      style={{
        width: FILE_TREE_WIDTH,
        minWidth: FILE_TREE_WIDTH,
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
            className="p-1 rounded-md cursor-pointer shrink-0"
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
      className="flex items-center h-10 shrink-0 border-b min-w-0"
      style={{ borderColor: "var(--color-border)" }}
    >
      <div className="no-scrollbar flex-1 flex items-center gap-1 px-2 min-w-0 h-full overflow-x-auto">
        {chatPanelCollapsed && (
          <button
            id="workspace-show-chat"
            type="button"
            onClick={onShowChat}
            className="flex items-center gap-1.5 px-2 py-1 rounded-md cursor-pointer shrink-0 text-[12px] font-medium"
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
            className="flex items-center gap-1.5 px-2 py-1 rounded-md cursor-pointer shrink-0 text-[12px] font-medium"
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
            Files
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
                    className="flex items-center gap-1.5 pl-2 pr-1 py-1 text-[12px] font-medium transition-colors cursor-pointer"
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
                    className="p-0.5 rounded-md mr-0.5 cursor-pointer"
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
      <button
        type="button"
        onClick={onCollapseRightPanel}
        className="p-1.5 mr-1 rounded-md cursor-pointer shrink-0"
        style={{ color: "var(--color-text-muted)" }}
        title="Hide right panel (⌘⇧B)"
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
      </button>
    </div>
  );
}
