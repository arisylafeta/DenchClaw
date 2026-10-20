import type { CSSProperties } from "react";
import styles from "./shimmer.module.css";

/** One animated placeholder block. Decorative: pair it with a labelled status wrapper. */
export function ShimmerBar({ w = "100%", h = 12, round = false, className = "", style }: { w?: number | string; h?: number | string; round?: boolean; className?: string; style?: CSSProperties }) {
  return <span aria-hidden className={`${styles.bar} ${round ? styles.round : ""} ${className}`} style={{ width: w, height: h, ...style }} />;
}

const WIDTHS = [62, 78, 55, 70, 48, 66, 74, 58];
const pick = (i: number, offset = 0) => `${WIDTHS[(i + offset) % WIDTHS.length]}%`;

/** List-like rows: avatar, two lines, a trailing time. */
export function RowsShimmer({ rows = 8, avatar = true }: { rows?: number; avatar?: boolean }) {
  return <div className="flex flex-col">{Array.from({ length: rows }, (_, i) => <div key={i} className="flex items-center gap-3 border-b px-4 py-3" style={{ borderColor: "var(--color-border)" }}>
    {avatar && <ShimmerBar w={40} h={40} round />}
    <div className="flex min-w-0 flex-1 flex-col gap-2"><ShimmerBar w={pick(i)} h={13} /><ShimmerBar w={pick(i, 3)} h={11} /></div>
    <ShimmerBar w={32} h={10} />
  </div>)}</div>;
}

/** Campaign-style rows: a title line and a strip of metric cells. */
export function CardRowsShimmer({ rows = 5 }: { rows?: number }) {
  return <div className="flex flex-col">{Array.from({ length: rows }, (_, i) => <div key={i} className="flex flex-col gap-3 border-b px-4 py-4" style={{ borderColor: "var(--color-border)" }}>
    <div className="flex items-center gap-3"><ShimmerBar w={pick(i, 1)} h={15} /><ShimmerBar w={64} h={20} round className="ml-auto" /></div>
    <div className="grid grid-cols-4 gap-4">{Array.from({ length: 4 }, (_, j) => <div key={j} className="flex flex-col gap-1.5"><ShimmerBar w="60%" h={9} /><ShimmerBar w="45%" h={16} /></div>)}</div>
  </div>)}</div>;
}

/** Chat transcript: alternating bubbles. */
export function ChatShimmer() {
  return <div className="flex flex-col gap-2 px-6 py-6">{[55, 38, 62, 30, 48, 58].map((width, i) => <div key={i} className={`flex ${i % 3 === 1 ? "justify-end" : "justify-start"}`}><ShimmerBar w={`${width}%`} h={i % 2 ? 40 : 54} style={{ borderRadius: 10 }} /></div>)}</div>;
}

/** Report/detail page: title, metric strip, table. */
export function DetailShimmer() {
  return <div className="flex flex-col gap-5 p-6"><ShimmerBar w="45%" h={26} /><ShimmerBar w="30%" h={12} />
    <div className="grid grid-cols-4 gap-4 rounded-lg border p-4 sm:grid-cols-7" style={{ borderColor: "var(--color-border)" }}>{Array.from({ length: 7 }, (_, i) => <div key={i} className="flex flex-col gap-2"><ShimmerBar w="70%" h={9} /><ShimmerBar w="50%" h={22} /></div>)}</div>
    <TableShimmer rows={6} cols={5} /></div>;
}

export function TableShimmer({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return <div className="flex flex-col overflow-hidden rounded-lg border" style={{ borderColor: "var(--color-border)" }}>
    <div className="flex gap-4 border-b px-4 py-3" style={{ borderColor: "var(--color-border)" }}>{Array.from({ length: cols }, (_, j) => <ShimmerBar key={j} w={`${100 / cols}%`} h={10} />)}</div>
    {Array.from({ length: rows }, (_, i) => <div key={i} className="flex gap-4 border-b px-4 py-3 last:border-b-0" style={{ borderColor: "var(--color-border)" }}>{Array.from({ length: cols }, (_, j) => <ShimmerBar key={j} w={`${100 / cols}%`} h={12} style={{ opacity: j === 0 ? 1 : 0.8 }} />)}</div>)}
  </div>;
}

const VARIANTS = { rows: RowsShimmer, cards: CardRowsShimmer, chat: ChatShimmer, detail: DetailShimmer, table: TableShimmer } as const;

/** Labelled loading state with a skeleton. The label stays available to screen readers and tests. */
export function Loading({ label, variant = "rows" }: { label: string; variant?: keyof typeof VARIANTS }) {
  const Variant = VARIANTS[variant];
  return <div role="status" aria-busy="true"><span className="sr-only">{label}</span><Variant /></div>;
}
