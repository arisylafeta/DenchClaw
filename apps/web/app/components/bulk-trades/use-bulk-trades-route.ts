"use client";

import { useCallback, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { BULK_TRADES_PATH, buildBulkTradesUrl, parseBulkTradesRoute, type BulkTradesRoute } from "@/lib/bulk-trades-url";

/**
 * The Bulk Trades page state, read from and written to the URL.
 *
 * The URL is the only copy: links, refresh and back/forward all go through it. Writes use the
 * History API (which Next keeps in sync with `useSearchParams`) so a value typed into a filter
 * is in the URL before the next keystroke, and the shell's own navigation never fires.
 */
export function useBulkTradesRoute(page: string = BULK_TRADES_PATH) {
  const searchParams = useSearchParams();
  const search = searchParams?.toString() ?? "";
  const route = useMemo(() => parseBulkTradesRoute(search), [search]);

  const navigate = useCallback((next: Partial<BulkTradesRoute>, mode: "push" | "replace" = "push") => {
    const url = buildBulkTradesUrl(next, new URLSearchParams(window.location.search), page);
    if (url === `${window.location.pathname}${window.location.search}`) return;
    // State is null on purpose: Next's own entries carry `__NA`, and passing that state back makes Next treat
    // this as its internal call and skip updating `useSearchParams`, so the URL changes but nothing re-renders.
    // With null, Next copies its internal state itself and syncs the router.
    if (mode === "replace") window.history.replaceState(null, "", url);
    else window.history.pushState(null, "", url);
  }, [page]);

  return { route, navigate };
}
