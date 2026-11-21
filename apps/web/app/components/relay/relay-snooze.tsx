"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Clock } from "lucide-react";
import { londonInputValue, londonWallToUtc, sendAtProblem, snoozeSlots } from "@/lib/relay-send-time";
import { cx } from "./relay-ui";
import w from "./relay-workspace.module.css";

/**
 * Snooze with a choice of how long, like Gmail: later today, tomorrow morning, Monday, a week, or a date and time of his
 * own (London time). The email comes back to the top of the list then. Esc or a click outside closes it.
 */
export function SnoozeMenu({ onPick }: { onPick: (until: string) => void }) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  const [value, setValue] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const slots = open ? snoozeSlots() : [];

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) close(); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);
  const close = () => { setOpen(false); setCustom(false); setProblem(null); };
  const pick = (until: string) => { close(); onPick(until); };
  const pickCustom = () => {
    const [date, time] = value.split("T");
    if (!date || !time) { setProblem("Pick a day and a time."); return; }
    const at = londonWallToUtc(date, time);
    const why = sendAtProblem(at);
    if (why) { setProblem(why); return; }
    pick(at.toISOString());
  };

  return (
    <div className={w.snooze} ref={box}>
      <button type="button" className={cx(w.act, open && w.actOn)} aria-haspopup="menu" aria-expanded={open}
        onClick={() => { setOpen(!open); setCustom(false); setValue(londonInputValue(new Date(Date.now() + 86_400_000))); }}>
        <Clock size={13} aria-hidden />Snooze<ChevronDown size={13} aria-hidden />
      </button>
      {open && (
        <div className={w.snoozeMenu} role="menu" aria-label="Snooze until">
          <span className={w.snoozeHead}>Snooze until…</span>
          {slots.map((s, k) => (
            <button key={s.key} type="button" role="menuitem" autoFocus={k === 0} onClick={() => pick(s.at)}>
              <span>{s.label}</span><span className={w.snoozeWhen}>{s.when}</span>
            </button>
          ))}
          {!custom ? (
            <button type="button" role="menuitem" onClick={() => setCustom(true)}><span>Pick a date and time</span></button>
          ) : (
            <div className={w.snoozeCustom}>
              <input type="datetime-local" value={value} min={londonInputValue(new Date())} aria-label="Snooze until (London time)"
                onChange={(e) => { setValue(e.target.value); setProblem(null); }} onKeyDown={(e) => { if (e.key === "Enter") pickCustom(); }} autoFocus />
              <button type="button" className={w.saveBtn} onClick={pickCustom}>Snooze</button>
              {problem && <span className={w.error} role="alert">{problem}</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
