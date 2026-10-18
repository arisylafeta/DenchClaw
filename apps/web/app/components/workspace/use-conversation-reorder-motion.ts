"use client";

import { useLayoutEffect, useRef } from "react";
import { useReducedMotion } from "framer-motion";
import type { ChatSection } from "@/lib/hermes-conversations";

/** Only row order invalidates layout measurements, not polling/status/selection. */
export function useConversationReorderMotion(sections: ChatSection[], scope: string) {
  const reducedMotion = useReducedMotion();
  const previousScope = useRef<string | null>(null);
  // A changed section or membership shifts headers too. Establish a new baseline
  // rather than sliding rows through headers that have already moved.
  const membership = JSON.stringify(sections.map(({ key, rows }) => [key, rows.map(row => row.key).sort()]));
  const previousMembership = useRef<string | null>(null);
  const duration = previousScope.current === scope && previousMembership.current === membership && reducedMotion === false ? 0.22 : 0;
  useLayoutEffect(() => { previousScope.current = scope; previousMembership.current = membership; }, [scope, membership]);

  return {
    layout: reducedMotion === false ? "position" as const : false as const,
    layoutDependency: JSON.stringify([scope, sections.map(({ key, rows }) => [key, rows.map((row) => row.key)])]),
    initial: false as const,
    transition: { layout: { duration, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] } },
  };
}
