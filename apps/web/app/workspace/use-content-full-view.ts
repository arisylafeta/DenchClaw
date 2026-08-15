"use client";

import { useEffect, useRef, useState } from "react";
import { FULL_VIEW_LAYOUT, type WorkspacePanelLayout } from "./content-layout";

function layoutsMatch(left: WorkspacePanelLayout, right: WorkspacePanelLayout): boolean {
  return left.chatPanelCollapsed === right.chatPanelCollapsed
    && left.fileTreeCollapsed === right.fileTreeCollapsed
    && left.rightPanelCollapsed === right.rightPanelCollapsed;
}

export function useContentFullView({
  active,
  layout,
  applyLayout,
}: {
  active: boolean;
  layout: WorkspacePanelLayout;
  applyLayout: (layout: WorkspacePanelLayout) => void;
}): boolean {
  const layoutRef = useRef(layout);
  const previousLayoutRef = useRef<WorkspacePanelLayout | null>(null);
  const [restoring, setRestoring] = useState(false);
  layoutRef.current = layout;

  useEffect(() => {
    if (active) {
      previousLayoutRef.current ??= layoutRef.current;
      setRestoring(true);
      applyLayout(FULL_VIEW_LAYOUT);
      return;
    }

    if (previousLayoutRef.current) {
      applyLayout(previousLayoutRef.current);
    }
  }, [active, applyLayout]);

  useEffect(() => {
    const previous = previousLayoutRef.current;
    if (active || !previous || !layoutsMatch(layout, previous)) return;
    previousLayoutRef.current = null;
    setRestoring(false);
  }, [active, layout]);

  return active || restoring;
}
