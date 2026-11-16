"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { BloubBot, type Block } from "bloub-react";
import { profileBlob } from "@/lib/profile-avatars";

// Working: the blob looks around, folds into thinking dots and comes back, on a loop.
const WORKING: Block[] = [{ state: "idle", duration: 1.6 }, { state: "thinking", duration: 2.6 }];
const SETTLE: Block[] = [{ state: "idle", duration: 2.4 }];
const SETTLE_MS = 900;
const scan = (t: number) => ({ yaw: 14 * Math.sin(t * Math.PI / 0.9), pitch: -3 + 4 * Math.sin(t * Math.PI / 0.45), mix: 1, spin: 0, wander: 0 });

// The bloub body is radius 100 in a 316-unit viewBox; scale the SVG so the body fills the slot.
const FILL = { position: "absolute", left: "-22%", top: "-22%", width: "144%", height: "144%" } as const;
const EYES = "#ffffff";

const REDUCE = "(prefers-reduced-motion: reduce)";
function subscribeReducedMotion(onChange: () => void) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia(REDUCE);
  query.addEventListener?.("change", onChange);
  return () => query.removeEventListener?.("change", onChange);
}
const reducedMotion = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(REDUCE).matches;

function LiveBlob({ shape, color, working }: { shape: string; color: string; working: boolean }) {
  const [block, setBlock] = useState(0);
  useEffect(() => { setBlock(0); }, [working]);
  return <BloubBot size={64} shape={shape} color={color} paper={EYES} style={FILL} cycle={working ? WORKING : SETTLE} block={block} onBlockChange={setBlock} gaze={working ? scan : null} playing />;
}

/** A bot's blob avatar. It animates only while `working`; otherwise it is a still frame with no animation loop. */
export function ProfileAvatar({ name, className = "h-8 w-8", working = false }: { name: string; className?: string; working?: boolean }) {
  const { shape, color } = profileBlob(name);
  const reduce = useSyncExternalStore(subscribeReducedMotion, reducedMotion, () => false);
  const animate = working && !reduce;
  // Keep the loop running briefly after work ends so the blob morphs back instead of snapping.
  const [settling, setSettling] = useState(false);
  const [wasAnimating, setWasAnimating] = useState(animate);
  if (wasAnimating !== animate) {
    setWasAnimating(animate);
    if (!animate && !reduce) setSettling(true);
  }
  useEffect(() => {
    if (!settling) return;
    const timer = setTimeout(() => setSettling(false), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [settling]);
  const live = animate || settling;
  return (
    <span aria-hidden="true" data-profile-avatar={name} data-working={animate || undefined} className={`relative inline-flex shrink-0 ${className}`}>
      {live
        ? <LiveBlob shape={shape} color={color} working={animate} />
        : <BloubBot size={64} shape={shape} color={color} paper={EYES} style={FILL} frozenAt={1} />}
    </span>
  );
}
