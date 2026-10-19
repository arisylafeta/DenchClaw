"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { TreeNode } from "./use-workspace-watcher";

const OBJECTS_CHANGED_EVENT = "workspace-objects-changed";

/** Explicit object metadata mutations, not file-watch or chat refresh events. */
export function notifyWorkspaceObjectsChanged() {
  window.dispatchEvent(new Event(OBJECTS_CHANGED_EVENT));
}

/** Canonical root objects have their own lifetime, independent of the file browser. */
export function useCrmNavigationTree() {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [loading, setLoading] = useState(true);
  const version = useRef(0);

  const refresh = useCallback(async () => {
    const requestVersion = ++version.current;
    try {
      // Reuse the root tree's backend detection, YAML icons and object projection.
      // Never use /browse here, or subscribe this data to filesystem/chat polling.
      const response = await fetch("/api/workspace/tree");
      if (!response.ok) throw new Error("Failed to load CRM navigation");
      const data = await response.json();
      if (!Array.isArray(data.tree)) throw new Error("Invalid CRM navigation tree");
      if (version.current === requestVersion) setTree(data.tree);
    } catch {
      // A transient metadata failure must not discard the last good navigation.
    } finally {
      if (version.current === requestVersion) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onObjectsChanged = () => { void refresh(); };
    window.addEventListener(OBJECTS_CHANGED_EVENT, onObjectsChanged);
    return () => {
      ++version.current;
      window.removeEventListener(OBJECTS_CHANGED_EVENT, onObjectsChanged);
    };
  }, [refresh]);

  return { tree, loading, refresh };
}
