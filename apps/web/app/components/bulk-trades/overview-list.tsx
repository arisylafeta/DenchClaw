"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { applyStrip, dueChip, moveLabel, moveOf, nextStrip, overviewGroups, stageTrack, stripCounts, type StripFilter } from "@/lib/bulk-overview";
import { formatEurCompact, sortRows, type SheetRow, type SheetSort } from "@/lib/bulk-sheet";
import { dealOwner, type DealOwner } from "@/lib/bulk-owner";
import { dayMonth, quickDays, weekdayDay } from "@/lib/next-action-dates";
import { BusyRegion, Sh } from "./bt-shimmer";
import { DriverAvatar } from "./desk-bits";
import { LikelihoodPicker } from "./likelihood-picker";
import { CheckButton, NextComposer, ReviewChip, postDone, putNext, type NextFields } from "./next-action";
import { ErrorText } from "./trade-ui";
import css from "./bulk-overview.module.css";
import nextCss from "./next-action.module.css";

/** Closes a popover on a click outside or Escape, and puts focus back on its trigger. */
export function usePopover() {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!wrap.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", escape); };
  }, [open]);
  return { open, setOpen, wrap, trigger };
}

const message = (err: unknown) => (err instanceof Error ? err.message : "Could not save.");

/** The "…" menu: the next-action tools that are not inline (tick done, add, reword, reschedule) and Copy ID. */
function RowMenu({ row, today, onMode, onReschedule }: {
  row: SheetRow; today: string; onMode: (mode: "completing" | "adding" | "editing") => void; onReschedule: (day: string | null) => Promise<void>;
}) {
  const { open, setOpen, wrap, trigger } = usePopover();
  const [view, setView] = useState<"main" | "date">("main");
  const [error, setError] = useState<string | null>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => { if (open) menu.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus(); }, [open, view]);
  const action = row.next_action;
  const pick = (mode: "completing" | "adding" | "editing") => { setOpen(false); onMode(mode); };
  async function reschedule(day: string | null) {
    setError(null);
    try { await onReschedule(day); setOpen(false); trigger.current?.focus(); } catch (err) { setError(message(err)); }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(row.id); } catch { /* clipboard refused: nothing to copy to */ }
    setOpen(false);
  }
  return (
    <span ref={wrap} className={css.popWrap}>
      <button ref={trigger} type="button" className={`${css.btn} ${css.icon}`} aria-label={`More actions for ${row.company ?? row.title}`}
        aria-haspopup="menu" aria-expanded={open} onClick={() => { setView("main"); setError(null); setOpen(!open); }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style={{ color: "var(--ov-sub)" }}><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
      </button>
      {open && (
        <div ref={menu} className={`${css.popover} ${css.menu}`}>
          {view === "main" ? (
            <div role="menu" aria-label={`Actions for ${row.company ?? row.title}`}>
              {action ? <>
                <button type="button" role="menuitem" className={css.menuItem} onClick={() => pick("completing")}>Mark done</button>
                <button type="button" role="menuitem" className={css.menuItem} onClick={() => setView("date")}>Reschedule…</button>
                <button type="button" role="menuitem" className={css.menuItem} onClick={() => pick("editing")}>Edit next action</button>
              </> : <button type="button" role="menuitem" className={css.menuItem} onClick={() => pick("adding")}>Add next action</button>}
              <div className={css.menuSep} />
              <button type="button" role="menuitem" className={css.menuItem} onClick={() => void copy()}>Copy ID</button>
            </div>
          ) : (
            <div role="menu" aria-label="Due date">
              {quickDays(today).map((quick) => (
                <button key={quick.day} type="button" role="menuitem" className={css.menuItem} onClick={() => void reschedule(quick.day)}>
                  {quick.label}<small>{quick.label === "Today" || quick.label === "Tomorrow" ? weekdayDay(quick.day) : ""}</small>
                </button>
              ))}
              {row.next_due && <button type="button" role="menuitem" className={css.menuItem} onClick={() => void reschedule(null)}>Clear date</button>}
              <div className={css.menuSep} />
              <label className={css.menuLabel} style={{ display: "block" }}>
                <span style={{ display: "block", marginBottom: 4 }}>Pick a date</span>
                <input type="date" className={css.dateInput} min={today} value={row.next_due?.slice(0, 10) ?? ""} onChange={(event) => event.target.value && void reschedule(event.target.value)} />
              </label>
              {error && <p role="alert" className={css.error} style={{ padding: "0 10px 4px" }}>{error}</p>}
            </div>
          )}
        </div>
      )}
    </span>
  );
}

/** The action's wording, edited in place: Enter or leaving the field saves, Escape cancels. */
function InlineEdit({ value, onSave, onDone }: { value: string; onSave: (text: string) => Promise<void>; onDone: () => void }) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const saving = useRef(false);
  async function commit() {
    if (saving.current) return;
    const next = draft.trim();
    if (!next || next === value) { onDone(); return; }
    saving.current = true;
    try { await onSave(next.slice(0, 300)); onDone(); } catch (err) { setError(message(err)); } finally { saving.current = false; }
  }
  return <>
    <input autoFocus aria-label="Next action" className={css.inlineEdit} value={draft} maxLength={300}
      onChange={(event) => setDraft(event.target.value)} onBlur={() => void commit()}
      onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void commit(); } if (event.key === "Escape") { event.preventDefault(); onDone(); } }} />
    {error && <span className={css.error}>{error}</span>}
  </>;
}

type RowProps = { row: SheetRow; today: string; showDriver: boolean; onOpen: (row: SheetRow) => void; onUpdate: (row: SheetRow, patch: Partial<SheetRow>) => void };

/** Who and what, money, whose move and the next step in full, then Open and "…". */
export function OverviewRow({ row, today, showDriver, onOpen, onUpdate }: RowProps) {
  const [mode, setMode] = useState<"view" | "completing" | "adding" | "editing">("view");
  const [setting, setSetting] = useState(false);
  const move = moveOf(row);
  const track = stageTrack(row.progress);
  const action = row.next_action;
  const due = row.next_due?.slice(0, 10) ?? null;
  const chip = action ? dueChip(due, today) : null;
  const owner = dealOwner(row.owner);
  const name = row.company ?? row.title;
  const saved = (next: NextFields) => { setMode("view"); onUpdate(row, next); };
  const last = row.latest ? `Last: ${(row.latest.kind ?? "activity").toLowerCase()}${row.latest.at ? `, ${dayMonth(row.latest.at.slice(0, 10))}` : ""}` : null;
  return (
    <li className={css.row} data-row={row.id} data-move={move}>
      <div className={css.who}>
        <div className={css.whoTop}>
          <button type="button" className={css.company} onClick={() => onOpen(row)} title={`Open ${name}`}>{name}</button>
          {row.is_trade && <span className={css.tag}>Trade</span>}
          {row.review && <ReviewChip />}
          {showDriver && <DriverAvatar owner={row.owner} size={18} />}
        </div>
        {row.company && <span className={css.ask}>{row.title}</span>}
        <div className={css.stage} role="img" aria-label={`Stage: ${row.progress}, step ${track.step} of 6`} data-stage-step={track.step}>
          <span className={css.track} aria-hidden="true">{track.segments.map((step, index) => <i key={index} data-step={step || undefined} />)}</span>
          <b>{row.progress}</b><span>{track.step} of 6</span>
        </div>
        {last && <span className={css.meta} title={row.latest?.label}>{last}</span>}
      </div>

      <div className={css.money} data-money>
        <b>{row.fee_eur != null ? formatEurCompact(row.fee_eur) : "—"}</b>
        <span>{row.fee_eur != null ? "fee" : "no fee yet"}{row.value_eur != null ? ` · ${formatEurCompact(row.value_eur)} ticket` : ""}</span>
        {row.likelihood != null
          ? <span data-chance>{row.likelihood}% chance</span>
          : setting
            ? <LikelihoodPicker listingId={row.id} likelihood={null} autoFocus onChanged={(likelihood) => { setSetting(false); onUpdate(row, { likelihood }); }} />
            : <button type="button" className={css.setlink} onClick={() => setSetting(true)}>Set chance</button>}
      </div>

      <div className={css.next}>
        <div className={css.line}>
          <span className={`${css.mv} ${move === "you" ? css.mvYou : css.mvThem}`} data-move-label>{moveLabel(row, today)}</span>
          {chip && <span className={css.due} data-tone={chip.tone} data-due>{chip.text}</span>}
        </div>
        {mode === "editing" && action
          ? <InlineEdit value={action} onDone={() => setMode("view")} onSave={async (text) => { await putNext(row.id, text, due); onUpdate(row, { next_action: text }); }} />
          : mode === "completing" && action ? (
            <div className={nextCss.root}>
              <div className={nextCss.doneLine}><CheckButton done small label="Done" /><s><span className="sr-only">Done: </span>{action}</s>
                <button type="button" className={nextCss.link} onClick={() => setMode("view")}>Undo</button></div>
              <NextComposer autoFocus compact today={today} owner={owner} label="What's next?" placeholder={`What's next on ${name}?`} submitLabel="Save"
                onSubmit={async (draft, ownerChanged) => { await postDone(row.id, action, draft, ownerChanged); saved({ next_action: draft.text, next_due: draft.due, owner: draft.owner }); }}
                onSkip={async () => { await postDone(row.id, action, null, false); saved({ next_action: null, next_due: null, owner }); }} />
            </div>
          ) : <p className={action ? undefined : css.none}>{action ?? "No next action yet."}</p>}
        {mode === "adding" && !action && (
          <div className={nextCss.root}>
            <NextComposer autoFocus compact today={today} owner={owner} placeholder={`Next action for ${name}`} submitLabel="Add"
              onSubmit={async (draft, ownerChanged) => { await putNext(row.id, draft.text, draft.due, ownerChanged ? draft.owner : null); saved({ next_action: draft.text, next_due: draft.due, owner: draft.owner }); }} />
            <button type="button" className={nextCss.link} onClick={() => setMode("view")}>Cancel</button>
          </div>
        )}
      </div>

      <div className={css.act}>
        <button type="button" className={`${css.btn} ${move === "you" ? css.btnPri : ""}`} onClick={() => onOpen(row)} aria-label={`Open ${name}`}>Open</button>
        <RowMenu row={row} today={today} onMode={setMode}
          onReschedule={async (day) => { await putNext(row.id, action, day); onUpdate(row, { next_due: day }); }} />
      </div>
    </li>
  );
}

function PlaceholderRows() {
  return (
    <ul className={css.list} aria-hidden="true">
      {Array.from({ length: 4 }, (_, index) => (
        <li key={index} className={css.row}>
          <div className={css.who}><Sh on chars={18} /><Sh on chars={30 + (index % 3) * 6} /><Sh on chars={16} /></div>
          <div className={css.money}><Sh on chars={5} /><Sh on chars={12} /></div>
          <div className={css.next}><Sh on chars={22} /><Sh on chars={40} /></div>
        </li>
      ))}
    </ul>
  );
}

const SECTIONS = [
  { key: "you", title: "Your move", sub: "You owe the next step. Most overdue first.", cls: css.mvYou },
  { key: "them", title: "Their move", sub: "Waiting on the other side. Chase when the date comes.", cls: css.mvThem },
] as const;

/**
 * Requests or Supply as the whose-move overview: the strip (your move, overdue, their move, all), then Your move,
 * Their move and a folded On track group. Rows come in already filtered by the header and the Filters popover.
 */
export function OverviewList({ rows, loading, error, today, owner, sort = "urgent", filtered, onOpen, onUpdate }: {
  rows: SheetRow[]; loading: boolean; error: string | null; today: string; owner: DealOwner | "all"; sort?: SheetSort;
  /** True when search or the Filters popover narrow the rows. */
  filtered: boolean;
  onOpen: (row: SheetRow) => void; onUpdate: (row: SheetRow, patch: Partial<SheetRow>) => void;
}) {
  const [strip, setStrip] = useState<StripFilter>("all");
  const [onTrackOpen, setOnTrackOpen] = useState(false);
  const groups = useMemo(() => overviewGroups(rows, today, sort === "urgent" ? undefined : (list) => sortRows(list, sort)), [rows, today, sort]);
  const counts = stripCounts(groups, today);
  const shown = applyStrip(groups, strip, today);
  const busy = loading && !rows.length;
  const showDriver = owner === "all";
  const allLabel = `all${owner === "all" ? "" : ` of ${owner}’s`}${counts.active ? ` · ${formatEurCompact(counts.fees_eur)} fees in these ${counts.active}` : ""}`;
  const stats: { key: StripFilter; n: number; label: string; cls: string }[] = [
    { key: "you", n: counts.you, label: "your move", cls: css.statYou },
    { key: "over", n: counts.over, label: "of them overdue", cls: css.statRed },
    { key: "them", n: counts.them, label: "their move", cls: css.statThem },
    { key: "all", n: counts.all, label: allLabel, cls: "" },
  ];
  const rowProps = { today, showDriver, onOpen, onUpdate };
  return (
    <BusyRegion busy={busy} label="Loading…" className={css.stack}>
      <section aria-label="Whose move" className={css.strip}>
        {stats.map((stat) => (
          <button key={stat.key} type="button" data-strip={stat.key} className={`${css.stat} ${stat.cls}`} aria-pressed={strip === stat.key}
            onClick={() => setStrip(nextStrip(strip, stat.key))}>
            <b><Sh on={busy} chars={2}>{stat.n}</Sh></b><span>{stat.label}</span>
          </button>
        ))}
      </section>
      <ErrorText error={error} />
      {busy ? (
        <section className={css.card} aria-label="Loading rows"><PlaceholderRows /></section>
      ) : !rows.length ? (
        <section className={css.card}><p className={css.empty}>{error ? "The sheet could not load." : filtered ? "Nothing matches these filters." : "Nothing live right now."}</p></section>
      ) : <>
        {SECTIONS.map((section) => {
          const list = shown[section.key];
          if (!list.length) return null;
          return (
            <section key={section.key} className={css.card} aria-label={section.title} data-group={section.key}>
              <div className={css.sec}>
                <h2><span className={`${css.mv} ${section.cls}`}>{section.title}</span><span className={css.muted} style={{ fontWeight: 600 }}>{list.length}</span></h2>
                <span className={css.sub}>{section.sub}</span>
              </div>
              <ul className={css.list}>{list.map((row) => <OverviewRow key={row.key} row={row} {...rowProps} />)}</ul>
            </section>
          );
        })}
        {!shown.you.length && !shown.them.length && strip !== "all" && (
          <section className={css.card}><p className={css.empty}>None right now.</p></section>
        )}
        {strip === "all" && groups.onTrack.length > 0 && (
          <section className={css.card} aria-label="On track" data-group="onTrack">
            <button type="button" className={css.fold} aria-expanded={onTrackOpen} onClick={() => setOnTrackOpen(!onTrackOpen)}>
              <span><b style={{ fontSize: 14 }}>On track · {groups.onTrack.length}</b> <span className={css.muted}>· nothing due this week</span></span>
              <span className={css.muted}>{onTrackOpen ? "Hide" : "Show"}</span>
            </button>
            {onTrackOpen && <ul className={css.list}>{groups.onTrack.map((row) => <OverviewRow key={row.key} row={row} {...rowProps} />)}</ul>}
          </section>
        )}
      </>}
    </BusyRegion>
  );
}
