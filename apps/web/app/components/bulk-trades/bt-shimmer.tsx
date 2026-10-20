import type { CSSProperties, ReactNode } from "react";
import styles from "./bt-shimmer.module.css";

/**
 * Text or a value that shimmers while its data loads. Put it where the real text goes:
 * `<Sh on={loading} chars={14}>{demand.buyer}</Sh>`. While `on`, the children are not rendered, only a bar
 * as wide as `chars` characters at the surrounding font size, so line height and layout do not move when
 * the data arrives. Cards, borders and backgrounds are never shimmered; wrap only text, numbers and chips.
 */
export function Sh({ on, chars = 10, w, round = false, className = "", style, children }: {
  on: boolean | null | undefined;
  /** Width in characters at the current font size. */
  chars?: number;
  /** Exact width instead, e.g. "40%" or 72. */
  w?: number | string;
  round?: boolean;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}) {
  if (!on) return <>{children}</>;
  return (
    <span aria-hidden className={`${styles.bar} ${round ? styles.round : ""} ${className}`} style={{ ...(w != null ? { width: w } : { minWidth: `${chars}ch` }), ...style }}>
      {"\u00a0"}
    </span>
  );
}

/** A circle or square placeholder for an avatar or icon slot whose content is loading (the slot's own background stays). */
export function ShBlock({ on, size, round = true, children }: { on: boolean | null | undefined; size: number; round?: boolean; children?: ReactNode }) {
  if (!on) return <>{children}</>;
  return <span aria-hidden className={`${styles.bar} ${round ? styles.round : ""}`} style={{ width: size, height: size }} />;
}

/** Wrap a loading region so assistive tech announces it. The visible content is the real structure with `Sh` placeholders. */
export function BusyRegion({ busy, label, className, children }: { busy: boolean; label: string; className?: string; children: ReactNode }) {
  return (
    <div aria-busy={busy || undefined} className={className}>
      {busy && <span role="status" className="sr-only">{label}</span>}
      {children}
    </div>
  );
}
