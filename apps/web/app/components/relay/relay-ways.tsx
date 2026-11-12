"use client";

import { useRef } from "react";
import { preview, segments, type WaysState } from "@/lib/relay-ways-core";
import { cx } from "./relay-ui";
import r from "./relay-review.module.css";

/** How long the writer gets before the page stops waiting and offers Try again. The server takes a stuck one back after the same time. */
const WRITER_MS = 5 * 60_000;
/** The other ways are being written right now. */
export const waysBusy = (ways: WaysState | null) => ways?.status === "preparing" && (!ways.at || Date.now() - new Date(ways.at).getTime() < WRITER_MS);

const COUNT = ["", "One way", "Two ways", "Three ways"];

/**
 * The ways to answer an email, one tab each: a name and the first words of the reply. The picked tab shows the draft
 * as it stands now (`current`), fills and edits included. off: the page asked for the other ways and got none.
 */
export function WayTabs({ ways, current, off, busy, onPick, onRetry }: {
  ways: WaysState | null; current: string; off?: "failed" | "none"; busy: boolean; onPick: (index: number) => void; onRetry: () => void;
}) {
  const ready = ways?.status === "ready" && ways.ways.length > 1;
  const writing = !off && (ways ? waysBusy(ways) : true);
  if (ready && ways) {
    return (
      <div className={r.ways}>
        <span className={r.wayline}><b>{COUNT[ways.ways.length] ?? `${ways.ways.length} ways`} to answer.</b> Pick one to read it.</span>
        <div className={cx(r.waysgrid, ways.ways.length === 2 && r.two)} role="group" aria-label="Ways to answer">
          {ways.ways.map((way, k) => (
            <button key={k} type="button" className={r.way} aria-pressed={k === ways.picked} disabled={busy && k !== ways.picked} onClick={() => { if (k !== ways.picked) onPick(k); }}>
              <b>{way.title}</b>
              <span>{preview(k === ways.picked ? current : way.body)}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }
  if (writing) {
    return (
      <div className={r.ways}>
        <span className={r.wayline} role="status"><b>Three ways to answer.</b> Relay is writing the other two. This one is ready to read.</span>
        <div className={r.waysgrid}>
          <button type="button" className={r.way} aria-pressed disabled><b>First draft</b><span>{preview(current)}</span></button>
          <div className={cx(r.way, r.wait)} aria-hidden><b>Writing another way…</b></div>
          <div className={cx(r.way, r.wait)} aria-hidden><b>Writing another way…</b></div>
        </div>
      </div>
    );
  }
  if (off === "none") return null;
  return (
    <div className={r.ways}>
      <span className={r.wayline}>Relay has one way to answer this, below.<button type="button" disabled={busy} onClick={onRetry}>Write other ways</button></span>
    </div>
  );
}

/**
 * A draft with a field in the sentence wherever it needs something only Alex knows. The field names what is missing;
 * Enter moves to the next one. onCommit: a field was left, so the page can save.
 */
export function GapBody({ template, values, disabled, onChange, onCommit }: {
  template: string; values: readonly string[]; disabled?: boolean; onChange: (index: number, value: string) => void; onCommit: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  return (
    <div className={r.bodytext} ref={root}>
      {segments(template).map((part, k) => {
        if ("text" in part) return <span key={k}>{part.text}</span>;
        const value = values[part.index] ?? "";
        const label = part.gap || "fill in";
        return (
          <input key={k} className={cx(r.gap, value.trim() && r.filled)} value={value} placeholder={label} aria-label={`Fill in: ${label}`} disabled={disabled}
            style={{ width: `${Math.min(44, Math.max(7, (value || label).length + 1))}ch` }}
            onChange={(e) => onChange(part.index, e.target.value)} onBlur={onCommit}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              const fields = Array.from(root.current?.querySelectorAll("input") ?? []);
              const next = fields[fields.indexOf(e.currentTarget) + 1];
              if (next) next.focus(); else e.currentTarget.blur();
            }} />
        );
      })}
    </div>
  );
}
