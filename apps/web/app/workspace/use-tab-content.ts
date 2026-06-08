"use client";

/**
 * `useTabContent` — single hook that owns content loading for the right panel.
 *
 * Design notes:
 *  - Replaces the old `loadContent` callback in `workspace-content.tsx`. That
 *    function set `activePath` and `content` together as a side effect of a
 *    click, which racing effects could then wipe.
 *  - This hook keys all fetched payloads by `tab.id` (which is stable — the
 *    workspace path for files/objects, a kind-prefixed key for entry profiles
 *    or browse mode). When the active tab changes, in-flight fetches for the
 *    previous tab are cancelled via AbortController.
 *  - The cache is bounded with a small LRU so users with many open tabs do
 *    not retain unbounded blob payloads (e.g. docx HTML).
 *  - Tabs that derive entirely from already-live state (folders → live tree,
 *    cron-job → live cronJobs, virtual panels with no fetch) bypass the cache
 *    and return the derived value directly so they react to upstream changes
 *    without manual invalidation.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type { TreeNode } from "../components/workspace/file-manager-tree";
import { isCodeFile } from "@/lib/report-utils";
import { isDocxFile, isTxtFile, textToHtml } from "../components/workspace/rich-document-editor";
import { isSpreadsheetFile } from "../components/workspace/file-viewer";
import { detectMediaType } from "../components/workspace/media-viewer";
import {
  fileReadUrl as fileApiUrl,
  rawFileReadUrl as rawFileUrl,
} from "@/lib/workspace-paths";
import type { CronJob } from "../types/cron";
import type {
  ContentState,
  DenchAppManifest,
  FileData,
  ObjectData,
} from "./content-state";
import type { ContentTab } from "@/lib/workspace-tabs";

const MAX_CACHE_ENTRIES = 20;

type CacheEntry = {
  /** Cached resolved content. Undefined while loading, never reached for sync kinds. */
  content?: ContentState;
  /** Most recent fetch generation; used to drop stale completions. */
  generation: number;
};

type CacheState = {
  /** Insertion-ordered. Oldest entries get evicted past MAX_CACHE_ENTRIES. */
  order: string[];
  entries: Record<string, CacheEntry>;
};

type CacheAction =
  | { type: "set"; id: string; content: ContentState; generation: number }
  | { type: "loading"; id: string; generation: number }
  | { type: "drop"; id: string }
  | { type: "clear" };

function cacheReducer(state: CacheState, action: CacheAction): CacheState {
  switch (action.type) {
    case "loading": {
      const order = state.order.includes(action.id)
        ? state.order
        : [...state.order, action.id];
      // Stale-while-revalidate: when refreshing an entry that already has
      // cached content (e.g. tree-driven auto refetch, post-edit refresh,
      // pagination reload), keep the previous content visible until the new
      // payload lands. This prevents the active right-panel view from
      // unmounting and flicking to a centered loading spinner / empty
      // table on every workspace SSE tick.
      const existing = state.entries[action.id];
      return {
        order: enforceLimit(order),
        entries: {
          ...state.entries,
          [action.id]: {
            generation: action.generation,
            content: existing?.content,
          },
        },
      };
    }
    case "set": {
      const existing = state.entries[action.id];
      // Drop late-arriving responses for cancelled / restarted fetches.
      if (existing && existing.generation !== action.generation) return state;
      const order = state.order.includes(action.id)
        ? state.order.filter((id) => id !== action.id).concat(action.id)
        : [...state.order, action.id];
      return {
        order: enforceLimit(order),
        entries: {
          ...state.entries,
          [action.id]: { generation: action.generation, content: action.content },
        },
      };
    }
    case "drop": {
      if (!(action.id in state.entries)) return state;
      const { [action.id]: _drop, ...entries } = state.entries;
      return {
        order: state.order.filter((id) => id !== action.id),
        entries,
      };
    }
    case "clear":
      if (state.order.length === 0) return state;
      return { order: [], entries: {} };
  }
}

function enforceLimit(order: string[]): string[] {
  if (order.length <= MAX_CACHE_ENTRIES) return order;
  return order.slice(order.length - MAX_CACHE_ENTRIES);
}

const INITIAL_CACHE: CacheState = { order: [], entries: {} };

// ---------------------------------------------------------------------------
// Hook surface
// ---------------------------------------------------------------------------

export type UseTabContentDeps = {
  /** Live workspace tree — drives directory-tab children and node-type lookups. */
  tree: TreeNode[];
  /** Cron jobs — drives cron-job tab content without needing a fetch. */
  cronJobs: CronJob[];
  /**
   * Optional callback invoked when an object tab indicates the workspace's
   * DuckDB file is missing. The right panel renders a `<DuckDBMissing />` in
   * that case.
   */
  onDuckDBMissing?: () => void;
};

export type UseTabContentResult = {
  /** What to render right now. Always defined; `{kind:"none"}` for the placeholder. */
  content: ContentState;
  /**
   * Force-refresh the active tab's payload. No-op for tabs that derive from
   * live state. Used after destructive actions (e.g. saving an object) and
   * by the workspace tree watcher to keep object data in sync with the
   * underlying DuckDB. Stale-while-revalidate: previous cached content
   * stays returned from `content` until the refetch resolves, so callers
   * never see a spurious loading flash mid-refresh.
   */
  refreshActive: () => void;
  /** Drop a single cached entry. Used when a tab is closed. */
  dropFromCache: (id: string) => void;
  /** Wipe the whole cache. Used on workspace switches. */
  clearCache: () => void;
};

/**
 * Resolve a tab into a `ContentState`, fetching as needed and caching by
 * `tab.id`.
 *
 *  - When `tab` is null → `{kind:"none"}`.
 *  - When `tab.kind` derives from live state → recompute on every render.
 *  - When `tab.kind` requires a fetch and the cache has no entry → emit
 *    `{kind:"loading"}` while the fetch is in flight, then store the result.
 *  - When `refreshActive()` re-fetches a tab that already has cached
 *    content → keep returning the existing content (stale-while-revalidate)
 *    so the right-panel view doesn't unmount and flick to a spinner / empty
 *    table on every refresh tick.
 */
export function useTabContent(
  tab: ContentTab | null,
  deps: UseTabContentDeps,
): UseTabContentResult {
  const [cache, dispatch] = useReducer(cacheReducer, INITIAL_CACHE);
  // The currently-running fetch generation per tab id, used to drop late
  // responses when the user clicks faster than the network.
  const generationRef = useRef<Map<string, number>>(new Map());
  const onDuckDBMissingRef = useRef(deps.onDuckDBMissing);
  useEffect(() => {
    onDuckDBMissingRef.current = deps.onDuckDBMissing;
  }, [deps.onDuckDBMissing]);

  const startFetch = useCallback(
    (target: ContentTab, signal: AbortSignal) => {
      const gen = (generationRef.current.get(target.id) ?? 0) + 1;
      generationRef.current.set(target.id, gen);
      dispatch({ type: "loading", id: target.id, generation: gen });

      void (async () => {
        try {
          const next = await fetchContent(target, signal);
          if (signal.aborted) return;
          if (next.kind === "duckdb-missing") {
            onDuckDBMissingRef.current?.();
          }
          dispatch({ type: "set", id: target.id, content: next, generation: gen });
        } catch (err) {
          if (signal.aborted) return;
          if ((err as { name?: string })?.name === "AbortError") return;
          dispatch({
            type: "set",
            id: target.id,
            content: { kind: "none" },
            generation: gen,
          });
        }
      })();
    },
    [],
  );

  // When the active tab changes, ensure its payload is loading or loaded.
  useEffect(() => {
    if (!tab) return;
    if (kindIsDerived(tab.kind)) return;
    const cached = cache.entries[tab.id]?.content;
    if (cached) return;
    const ctrl = new AbortController();
    startFetch(tab, ctrl.signal);
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cache changes shouldn't trigger refetch
  }, [tab?.id, tab?.kind, startFetch]);

  // Resolve the current content state. Derived kinds re-derive each render
  // from the live `tree` / `cronJobs`; fetched kinds read from cache.
  const content = useMemo<ContentState>(() => {
    if (!tab) return { kind: "none" };
    if (kindIsDerived(tab.kind)) {
      return resolveDerivedContent(tab, { tree: deps.tree, cronJobs: deps.cronJobs });
    }
    const entry = cache.entries[tab.id];
    if (!entry) return { kind: "loading" };
    return entry.content ?? { kind: "loading" };
  }, [tab, cache, deps.tree, deps.cronJobs]);

  const refreshActive = useCallback(() => {
    if (!tab) return;
    if (kindIsDerived(tab.kind)) return;
    const ctrl = new AbortController();
    startFetch(tab, ctrl.signal);
  }, [tab, startFetch]);

  const dropFromCache = useCallback((id: string) => {
    dispatch({ type: "drop", id });
  }, []);

  const clearCache = useCallback(() => {
    dispatch({ type: "clear" });
  }, []);

  return { content, refreshActive, dropFromCache, clearCache };
}

// ---------------------------------------------------------------------------
// Derived (no-fetch) kinds
// ---------------------------------------------------------------------------

function kindIsDerived(kind: ContentTab["kind"]): boolean {
  switch (kind) {
    case "directory":
    case "browse":
    case "cron-dashboard":
    case "cron-job":
    case "skills":
    case "integrations":
    case "cloud":
    case "crm-inbox":
    case "crm-calendar":
    case "crm-person":
    case "crm-company":
      return true;
    default:
      return false;
  }
}

function resolveDerivedContent(
  tab: ContentTab,
  deps: { tree: TreeNode[]; cronJobs: CronJob[] },
): ContentState {
  switch (tab.kind) {
    case "directory": {
      const node = findNode(deps.tree, tab.path);
      if (node) return { kind: "directory", node };
      return {
        kind: "directory",
        node: { name: tab.title, path: tab.path, type: "folder" },
      };
    }
    case "browse": {
      const browsePath = tab.meta?.browsePath ?? tab.path;
      return {
        kind: "directory",
        node: { name: tab.title, path: browsePath, type: "folder" },
      };
    }
    case "cron-dashboard":
      return { kind: "cron-dashboard" };
    case "cron-job": {
      const jobId = tab.meta?.cronJobId ?? tab.path.replace(/^~cron\//, "");
      const job = deps.cronJobs.find((j) => j.id === jobId);
      if (job) return { kind: "cron-job", jobId, job };
      // Cron jobs can arrive after the tab opens; show the dashboard until
      // the job loads so the user has somewhere to click back from.
      return { kind: "cron-dashboard" };
    }
    case "skills":
      return { kind: "skill-store" };
    case "integrations":
      return { kind: "integrations" };
    case "cloud":
      return { kind: "cloud" };
    case "crm-inbox":
      return { kind: "crm-inbox" };
    case "crm-calendar":
      return { kind: "crm-calendar" };
    case "crm-person":
      return {
        kind: "crm-person",
        entryId: tab.meta?.entryId ?? "",
        profileTab: tab.meta?.profileTab,
      };
    case "crm-company":
      return {
        kind: "crm-company",
        entryId: tab.meta?.entryId ?? "",
        profileTab: tab.meta?.profileTab,
      };
    default:
      return { kind: "none" };
  }
}

function findNode(tree: TreeNode[], path: string): TreeNode | null {
  for (const node of tree) {
    if (node.path === path) return node;
    if (node.children) {
      const found = findNode(node.children, path);
      if (found) return found;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fetcher per kind
// ---------------------------------------------------------------------------

async function fetchContent(
  tab: ContentTab,
  signal: AbortSignal,
): Promise<ContentState> {
  switch (tab.kind) {
    case "object":
      return fetchObjectContent(tab, signal);
    case "document":
      return fetchDocumentContent(tab, signal);
    case "database":
      return { kind: "database", dbPath: tab.path, filename: tab.title };
    case "report":
      return { kind: "report", reportPath: tab.path, filename: tab.title };
    case "app":
      return fetchAppContent(tab, signal);
    case "file":
      return fetchFileContent(tab, signal);
    default:
      return { kind: "none" };
  }
}

async function fetchObjectContent(
  tab: ContentTab,
  signal: AbortSignal,
): Promise<ContentState> {
  const objectName = tab.path.split("/").pop() ?? tab.path;
  const fetchOnce = async (): Promise<
    | { status: "ok"; data: ObjectData }
    | { status: "retryable" }
    | { status: "duckdb-missing" }
    | { status: "fatal" }
  > => {
    const res = await fetch(`/api/workspace/objects/${encodeURIComponent(objectName)}`, { signal });
    const data = await res.json().catch(() => ({} as Partial<ObjectData> & { code?: string }));
    if (!res.ok) {
      if (data.code === "DUCKDB_NOT_INSTALLED") return { status: "duckdb-missing" };
      if (res.status === 404 || res.status >= 500) return { status: "retryable" };
      return { status: "fatal" };
    }
    return { status: "ok", data: data as ObjectData };
  };

  let result = await fetchOnce();
  if (result.status === "retryable") {
    await sleep(150, signal);
    result = await fetchOnce();
  }
  if (result.status === "duckdb-missing") return { kind: "duckdb-missing" };
  if (result.status !== "ok") return { kind: "none" };

  let data = result.data;
  // Race between DuckDB writes and reads can briefly return zero fields.
  if (data.fields.length === 0 && data.entries.length > 0) {
    await sleep(200, signal);
    const retry = await fetchOnce();
    if (retry.status === "duckdb-missing") return { kind: "duckdb-missing" };
    if (retry.status === "ok") data = retry.data;
  }
  return { kind: "object", data };
}

async function fetchDocumentContent(
  tab: ContentTab,
  signal: AbortSignal,
): Promise<ContentState> {
  const res = await fetch(fileApiUrl(tab.path), { signal });
  if (!res.ok) return { kind: "none" };
  const data: FileData = await res.json();
  return {
    kind: "document",
    data,
    title: tab.title.replace(/\.md$/, ""),
  };
}

async function fetchFileContent(
  tab: ContentTab,
  signal: AbortSignal,
): Promise<ContentState> {
  const filename = tab.title;
  const filePath = tab.path;

  if (isSpreadsheetFile(filename)) {
    return {
      kind: "spreadsheet",
      url: rawFileUrl(filePath),
      filename,
      filePath,
    };
  }

  if (isDocxFile(filename)) {
    const rawRes = await fetch(rawFileUrl(filePath), { signal });
    if (!rawRes.ok) return { kind: "none" };
    const arrayBuffer = await rawRes.arrayBuffer();
    if (signal.aborted) return { kind: "none" };
    const mammoth = await import("mammoth");
    const result = await mammoth.convertToHtml({ arrayBuffer });
    if (signal.aborted) return { kind: "none" };
    return { kind: "richDocument", html: result.value, filePath, mode: "docx" };
  }

  if (isTxtFile(filename)) {
    const res = await fetch(fileApiUrl(filePath), { signal });
    if (!res.ok) return { kind: "none" };
    const data: FileData = await res.json();
    return { kind: "richDocument", html: textToHtml(data.content), filePath, mode: "txt" };
  }

  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "html" || ext === "htm") {
    return {
      kind: "html",
      rawUrl: rawFileUrl(filePath),
      contentUrl: fileApiUrl(filePath),
      filename,
    };
  }

  const mediaType = detectMediaType(filename);
  if (mediaType) {
    return {
      kind: "media",
      url: rawFileUrl(filePath),
      mediaType,
      filename,
      filePath,
    };
  }

  const res = await fetch(fileApiUrl(filePath), { signal });
  if (!res.ok) return { kind: "none" };
  const data: FileData = await res.json();
  if (isCodeFile(filename)) {
    return { kind: "code", data, filename, filePath };
  }
  return { kind: "file", data, filename };
}

async function fetchAppContent(
  tab: ContentTab,
  signal: AbortSignal,
): Promise<ContentState> {
  const manifestRes = await fetch(
    `/api/apps?app=${encodeURIComponent(tab.path)}&file=.dench.yaml&meta=1`,
    { signal },
  );
  let manifest: DenchAppManifest = { name: tab.title };
  if (manifestRes.ok) {
    try {
      manifest = await manifestRes.json();
    } catch {
      // Use the default manifest with just the name.
    }
  }
  return { kind: "app", appPath: tab.path, manifest, filename: tab.title };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const id = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(id);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
