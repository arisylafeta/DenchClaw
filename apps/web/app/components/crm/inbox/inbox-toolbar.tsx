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
    hideSearch?: boolean;
  }
>(function InboxToolbar(
  {
    search,
    onSearchChange,
    selectedCount,
    onClearSelection,
    onBulkAction,
    hideSearch = false,
  },
  searchInputRef,
) {
  return (
    <div
      className="shrink-0 flex flex-col"
      style={selectedCount > 0 || !hideSearch ? { borderBottom: "1px solid var(--color-border)" } : undefined}
    >
      {!hideSearch && <div className="flex items-center gap-2 px-4 py-2">
        <Input
          ref={searchInputRef as RefObject<HTMLInputElement>}
          placeholder="Search subject + sender…"
          value={search}
          onChange={(e: ChangeEvent<HTMLInputElement>) => onSearchChange(e.target.value)}
          className="h-8 flex-1 text-[13px]"
        />
      </div>}

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
