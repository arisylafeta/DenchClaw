"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SubscribeWorkspaceChanges, TreeNode } from "./use-workspace-watcher";

const OBJECTS_CHANGED_EVENT = "workspace-objects-changed";

/** Explicit object metadata mutations, not chat refresh events. */
export function notifyWorkspaceObjectsChanged() {
  window.dispatchEvent(new Event(OBJECTS_CHANGED_EVENT));
}

/** Canonical root objects have their own lifetime, independent of the file browser. */
export function useCrmNavigationTree(workspace?: string | null, subscribeChanges?: SubscribeWorkspaceChanges) {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [loading, setLoading] = useState(true);
  const version = useRef(0);

  const refresh = useCallback(async (reset = false) => {
    const requestVersion = ++version.current;
    if (reset) {
      setTree([]);
      setLoading(true);
    }
    try {
      // Preserve backend detection, YAML icons and DB-only object projection.
      const response = await fetch("/api/workspace/tree");
      if (!response.ok) throw new Error("Failed to load CRM navigation");
      const data = await response.json();
      if (!Array.isArray(data.tree)) throw new Error("Invalid CRM navigation tree");
      if (version.current === requestVersion) setTree(data.tree);
    } catch {
      // Only same-workspace refreshes retain the last good navigation.
    } finally {
      if (version.current === requestVersion) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh(true);
    return () => { ++version.current; };
  }, [workspace, refresh]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onObjectsChanged = () => { void refresh(); };
    const unsubscribe = subscribeChanges?.(event => {
      // Metadata and directory lifecycle changes can add/remove/rename objects.
      // Ordinary file writes, including chat artifacts, never refresh navigation.
      const path = event.path.replace(/\\/g, "/");
      if (!/(^|\/)\.object\.ya?ml$/.test(path)
        && event.type !== "addDir" && event.type !== "unlinkDir") return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { void refresh(); }, 300);
    });
    window.addEventListener(OBJECTS_CHANGED_EVENT, onObjectsChanged);
    // Recover an initial failure and metadata changes made outside this page.
    window.addEventListener("focus", onObjectsChanged);
    window.addEventListener("online", onObjectsChanged);
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe?.();
      window.removeEventListener(OBJECTS_CHANGED_EVENT, onObjectsChanged);
      window.removeEventListener("focus", onObjectsChanged);
      window.removeEventListener("online", onObjectsChanged);
    };
  }, [refresh, subscribeChanges]);

  return { tree, loading, refresh };
}
