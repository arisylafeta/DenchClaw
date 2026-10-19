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
        element.style.removeProperty("--workspace-visible-top");
        return;
      }
      // Zoom must remain available; it is not a signal to resize the app shell.
      if (viewport.scale !== 1 || viewport.height <= 0) return;
      element.style.setProperty("--workspace-visible-height", `${viewport.height}px`);
      // iOS pans the page when the keyboard opens; pin the shell to the visible area instead of letting the composer jump.
      element.style.setProperty("--workspace-visible-top", `${viewport.offsetTop}px`);
      if (viewport.offsetTop > 0 && window.scrollY !== 0) window.scrollTo(0, 0);
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    narrow.addEventListener("change", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      narrow.removeEventListener("change", update);
      element.style.removeProperty("--workspace-visible-height");
      element.style.removeProperty("--workspace-visible-top");
    };
  }, [ref]);
}
