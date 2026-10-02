"use client";

import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ComponentProps, type MouseEvent, type KeyboardEvent, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import styles from "./data-table.module.css";

const ExpandedContext = createContext<boolean | null>(null);
export function useTableCellExpanded() { return useContext(ExpandedContext); }

// One observer serves every visible cell, including cells resized by their column.
const resizeCallbacks = new WeakMap<Element, () => void>();
let resizeObserver: ResizeObserver | undefined;
function observeCell(element: HTMLElement, callback: () => void) {
  if (typeof ResizeObserver === "undefined") { return () => {}; }
  resizeObserver ??= new ResizeObserver((entries) => {
    for (const entry of entries) { resizeCallbacks.get(entry.target)?.(); }
  });
  resizeCallbacks.set(element, callback);
  resizeObserver.observe(element);
  return () => { resizeObserver?.unobserve(element); resizeCallbacks.delete(element); };
}

function isInteractive(target: EventTarget | null, boundary: HTMLElement) {
  const control = target instanceof Element ? target.closest("a, button, input, textarea, select, [contenteditable='true'], [role='button'], [role='combobox'], [role='menuitem']") : null;
  return Boolean(control && boundary.contains(control));
}
function overflows(element: HTMLElement) {
  if (element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1) { return true; }
  // Existing formatted values can truncate internally before the containing cell does.
  for (const child of element.querySelectorAll<HTMLElement>("*")) {
    if (child.scrollWidth > child.clientWidth + 1 || child.scrollHeight > child.clientHeight + 1) { return true; }
    if (child.dataset.tableCellOverflow === "true") { return true; }
  }
  return false;
}

export function TableCellContent({ children, className }: { children: ReactNode; className?: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflow, setOverflow] = useState(false);
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const content = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const disclosure = useRef<HTMLButtonElement>(null);
  const id = useId();
  const measure = useCallback(() => {
    if (content.current && !expandedRef.current) { setOverflow(overflows(content.current)); }
  }, []);
  useLayoutEffect(measure);
  useEffect(() => content.current ? observeCell(content.current, measure) : undefined, [measure]);
  const toggle = () => setExpanded((current) => !current);
  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!overflow || event.detail > 1 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || isInteractive(event.target, event.currentTarget)) { return; }
    const selection = window.getSelection();
    if (selection?.toString() && selection.anchorNode && event.currentTarget.contains(selection.anchorNode)) { return; }
    event.stopPropagation();
    toggle();
    container.current?.focus({ preventScroll: true });
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || !expanded || (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable='true'], [role='combobox'], [role='menuitem']"))) { return; }
    event.stopPropagation();
    setExpanded(false);
    disclosure.current?.focus();
  };
  return (
    <ExpandedContext.Provider value={expanded}>
      <div ref={container} tabIndex={-1} className={cn(styles.cellContent, className)} onKeyDown={handleKeyDown}>
        <div ref={content} id={id} data-table-part="cell-value" data-expanded={expanded ? "true" : "false"} data-overflow={overflow ? "true" : undefined} className={cn(styles.cellValue, expanded ? styles.cellExpanded : styles.cellCollapsed)} onClick={handleClick}>
          {children}
        </div>
        {(overflow || expanded) && <button ref={disclosure} type="button" aria-label={expanded ? "Collapse cell content" : "Expand cell content"} aria-expanded={expanded} aria-controls={id} className={styles.cellDisclosure} onClick={(event) => { event.stopPropagation(); toggle(); }}>
          {expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
        </button>}
      </div>
    </ExpandedContext.Provider>
  );
}

export function TableCell({ children, className, colSpan, ...props }: ComponentProps<"td">) {
  return <td {...props} colSpan={colSpan} className={cn(styles.cell, className)}>{colSpan && colSpan > 1 ? children : <TableCellContent>{children}</TableCellContent>}</td>;
}
