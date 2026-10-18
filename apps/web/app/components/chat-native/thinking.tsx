"use client";

// Chevron wavefront delays (ms) for a 3x3 grid, as in rebattery-platform's LoadingState "Drive" variant.
const DELAYS = Array.from({ length: 9 }, (_, index) => ((index % 3) + Math.abs(Math.floor(index / 3) - 1)) * 90);

/** 3x3 pixel grid with a wavefront; sized to sit in a trace step's node slot. */
export function PixelGrid() {
  return <span aria-hidden="true" className="grid shrink-0 grid-cols-[repeat(3,3.5px)] gap-[1.5px] text-[var(--color-text)]">
    {DELAYS.map((delay, index) => <span key={index} className="chat-pixel-cell size-[3.5px] rounded-[1px] bg-current" style={{ animationDelay: `${delay}ms` }} />)}
  </span>;
}
/** The thinking indicator: pixel grid plus a shimmering label. Children render the label, e.g. "Thinking 12s". */
export function ThinkingIndicator({ children }: { children: React.ReactNode }) {
  return <span role="status" className="flex w-fit max-w-full items-center gap-2.5"><PixelGrid /><span className="chat-shimmer-label min-w-0 text-[12px] font-medium">{children}</span></span>;
}
