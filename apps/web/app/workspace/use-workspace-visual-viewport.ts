"use client";

import { useEffect, type RefObject } from "react";

/** Safari's keyboard can shrink the visual viewport without resizing 100dvh. */
export function useWorkspaceVisualViewport(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const element = ref.current;
    const viewport = window.visualViewport;
    if (!element || !viewport) return;
    const narrow = window.matchMedia("(max-width: 1023px)");
    const update = () => {
      if (!narrow.matches) {
        element.style.removeProperty("--workspace-visible-height");
        return;
      }
      // Zoom must remain available; it is not a signal to resize the app shell.
      if (viewport.scale !== 1 || viewport.height <= 0) return;
      element.style.setProperty("--workspace-visible-height", `${viewport.height}px`);
    };
    update();
    viewport.addEventListener("resize", update);
    narrow.addEventListener("change", update);
    return () => {
      viewport.removeEventListener("resize", update);
      narrow.removeEventListener("change", update);
      element.style.removeProperty("--workspace-visible-height");
    };
  }, [ref]);
}
