"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";

const STORAGE_KEY = "denchclaw.crm-inbox.list-width";
const MIN_WIDTH = 320;
const MAX_WIDTH = 640;
const DEFAULT_WIDTH = 420;
const COLLAPSE_BREAKPOINT = 900;
const COLLAPSE_DRAG_SLACK = 70;
/** WhatsApp and Campaigns: list and open item share the pane down to a narrow width, like mail threads. */
export const PANEL_LAYOUT = { collapseBelow: 560, defaultWidth: 380, minWidth: 280, storageKey: "denchclaw.crm-inbox.panel-width" } as const;

/**
 * Responsive shell for the inbox.
 *
 * Modes:
 *   - desktop (>= 900px)
 *       → two-pane split, resizable drag handle between list + reader.
 *         Width is persisted to localStorage so it's stable across visits.
 *   - narrow (<  900px)
 *       → single-pane drilldown. Show list when no thread is selected,
 *         otherwise show conversation pane (with back-to-list affordance
 *         baked into ConversationHeader).
 */
export function InboxLayout({
  list,
  conversation,
  hasSelection,
  collapseBelow = COLLAPSE_BREAKPOINT,
  defaultWidth = DEFAULT_WIDTH,
  minWidth = MIN_WIDTH,
  storageKey = STORAGE_KEY,
}: {
  list: ReactNode;
  conversation: ReactNode;
  hasSelection: boolean;
  /** Container width under which the list and the open item stop sharing the screen. */
  collapseBelow?: number;
  defaultWidth?: number;
  minWidth?: number;
  storageKey?: string;
}) {
  const [width, setWidth] = useState<number>(defaultWidth);
  const [isNarrow, setIsNarrow] = useState<boolean>(false);
  // Dragging the divider well past the minimum width, or the handle, hides the list so the open item can fill the pane.
  const [collapsed, setCollapsed] = useState(false);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Hydrate persisted width.
  useEffect(() => {
    if (typeof window === "undefined") {return;}
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw) {
        const parsed = parseInt(raw, 10);
        if (Number.isFinite(parsed)) {
          setWidth(clamp(parsed, minWidth, MAX_WIDTH));
        }
      }
    } catch {
      /* ignore */
    }
  }, []);

  // Track narrow viewport via container width — using ResizeObserver on
  // the layout itself so we adapt to the workspace shell's main panel
  // resizing, not just the viewport.
  useEffect(() => {
    if (typeof ResizeObserver === "undefined" || !containerRef.current) {return;}
    const observer = new ResizeObserver(([entry]) => {
      setIsNarrow(entry.contentRect.width < collapseBelow);
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startWidth: width };
  }, [width]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current) {return;}
      const delta = e.clientX - dragRef.current.startX;
      const raw = dragRef.current.startWidth + delta;
      if (raw < minWidth - COLLAPSE_DRAG_SLACK) { dragRef.current = null; setCollapsed(true); return; }
      setWidth(clamp(raw, minWidth, MAX_WIDTH));
    };
    const onUp = () => {
      if (dragRef.current) {
        try {
          window.localStorage.setItem(storageKey, String(width));
        } catch {
          /* ignore */
        }
      }
      dragRef.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [width]);

  // ─── Single-pane (narrow) ─────────────────────────────────────────────
  if (isNarrow) {
    return (
      <div ref={containerRef} className="h-full min-h-0 w-full">
        {hasSelection ? conversation : list}
      </div>
    );
  }

  // ─── Two-pane split ───────────────────────────────────────────────────
  const showList = !collapsed || !hasSelection;
  return (
    <div ref={containerRef} className="flex h-full min-h-0 w-full">
      {showList && <div
        className="flex h-full min-h-0 flex-col"
        style={{
          width,
          minWidth,
          background: "var(--color-bg)",
          borderRight: "1px solid var(--color-border)",
        }}
      >
        {list}
      </div>}
      {showList && <div
        role="separator"
        aria-orientation="vertical"
        onMouseDown={handleMouseDown}
        className="shrink-0 cursor-col-resize transition-colors"
        style={{
          width: 4,
          background: "transparent",
          marginLeft: -2,
          marginRight: -2,
          zIndex: 1,
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLElement).style.background = "var(--color-accent-light)";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLElement).style.background = "transparent";
        }}
      />}
      <div className="relative flex-1 min-w-0 h-full min-h-0">
        {hasSelection && <button type="button" onClick={() => setCollapsed((value) => !value)} aria-label={collapsed ? "Show list" : "Hide list"} title={collapsed ? "Show list" : "Hide list"}
          className="absolute bottom-3 left-3 z-20 inline-flex h-8 w-8 items-center justify-center rounded-full border shadow-sm hover:bg-[var(--color-surface-hover)]"
          style={{ background: "var(--color-surface)", borderColor: "var(--color-border)", color: "var(--color-text-muted)" }}>
          {collapsed ? <PanelLeftOpen size={15} aria-hidden /> : <PanelLeftClose size={15} aria-hidden />}
        </button>}
        {conversation}
      </div>
    </div>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
