"use client";

import { type ChangeEvent, type RefObject, forwardRef } from "react";
import { Input } from "../../ui/input";

/**
 * Top-of-pane toolbar above the thread list. Search and the
 * bulk-select strip when one or more rows are checked.
 *
 * The bulk actions (Mark read / Star / Archive) are intentionally
 * mocked — they fire a toast pointing at the two-way Gmail sync
 * milestone. The visual affordance is in place so the muscle memory
 * matches Gmail.
 */
export const InboxToolbar = forwardRef<
  HTMLInputElement,
  {
    search: string;
    onSearchChange: (value: string) => void;
    selectedCount: number;
    onClearSelection: () => void;
    onBulkAction: (action: "read" | "star" | "archive") => void;
    onOpenShortcuts: () => void;
    hideSearch?: boolean;
    unreadCount?: number;
  }
>(function InboxToolbar(
  {
    search,
    onSearchChange,
    selectedCount,
    onClearSelection,
    onBulkAction,
    onOpenShortcuts,
    hideSearch = false,
    unreadCount = 0,
  },
  searchInputRef,
) {
  return (
    <div
      className="shrink-0 flex flex-col"
      style={{ borderBottom: "1px solid var(--color-border)" }}
    >
      {/* Top row: search + shortcuts */}
      <div className="flex items-center gap-2 px-4 py-2">
        {!hideSearch && <Input
          ref={searchInputRef as RefObject<HTMLInputElement>}
          placeholder="Search subject + sender…"
          value={search}
          onChange={(e: ChangeEvent<HTMLInputElement>) => onSearchChange(e.target.value)}
          className="h-8 flex-1 text-[13px]"
        />}
        {hideSearch && <span aria-label="Unread conversations" className="flex-1 text-[11px] font-normal" style={{ color: "var(--color-text-muted)" }}>{unreadCount} unread conversations</span>}
        <button
          type="button"
          onClick={onOpenShortcuts}
          title="Keyboard shortcuts (?)"
          className="inline-flex h-8 w-8 items-center justify-center rounded-full transition-colors hover:bg-[var(--color-surface-hover)]"
          style={{ color: "var(--color-text-muted)" }}
        >
          <KbdIcon />
        </button>
      </div>

      {/* Bulk action strip — only when one or more rows are checked */}
      {selectedCount > 0 && (
        <div
          className="flex items-center gap-2 px-4 py-2"
          style={{
            background: "var(--color-accent-light)",
            borderTop: "1px solid var(--color-border)",
          }}
        >
          <span className="text-[12px] font-medium" style={{ color: "var(--color-text)" }}>
            {selectedCount.toLocaleString()} selected
          </span>
          <button
            type="button"
            onClick={onClearSelection}
            className="text-[11px] hover:underline"
            style={{ color: "var(--color-text-muted)" }}
          >
            Clear
          </button>
          <span className="flex-1" />
          <BulkButton onClick={() => onBulkAction("read")}>Mark read</BulkButton>
          <BulkButton onClick={() => onBulkAction("star")}>Star</BulkButton>
          <BulkButton onClick={() => onBulkAction("archive")}>Archive</BulkButton>
        </div>
      )}
    </div>
  );
});

function BulkButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium transition-colors hover:bg-[var(--color-surface)]"
      style={{ color: "var(--color-text)" }}
    >
      {children}
    </button>
  );
}

function KbdIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <line x1="6" y1="10" x2="6.01" y2="10" />
      <line x1="10" y1="10" x2="10.01" y2="10" />
      <line x1="14" y1="10" x2="14.01" y2="10" />
      <line x1="18" y1="10" x2="18.01" y2="10" />
      <line x1="6" y1="14" x2="18" y2="14" />
    </svg>
  );
}
