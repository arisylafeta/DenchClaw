"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, Pencil } from "lucide-react";
import { DEAL_OWNERS, dealOwner, type DealOwner } from "@/lib/bulk-owner";
import { addDays, dueLabel, quickDays, shortDue, weekdayDay } from "@/lib/next-action-dates";
import { DriverAvatar } from "./desk-bits";
import { request } from "./trade-ui";
import css from "./next-action.module.css";

export type NextFields = { next_action: string | null; next_due: string | null; owner: DealOwner | null };
type Draft = { text: string; due: string | null; owner: DealOwner | null };

const nextUrl = (id: string) => `/api/bulk-listings/${encodeURIComponent(id)}/next`;

async function putNext(id: string, text: string | null, due: string | null) {
  await request(nextUrl(id), { method: "PUT", body: JSON.stringify({ next_action: text, next_due: text ? due : null }) });
}
async function putOwner(id: string, owner: DealOwner) {
  await request(`/api/bulk-listings/${encodeURIComponent(id)}/owner`, { method: "PUT", body: JSON.stringify({ owner }) });
}
async function postDone(id: string, done: string, draft: Draft | null, ownerChanged: boolean) {
  await request(nextUrl(id), { method: "POST", body: JSON.stringify({
    done, next_action: draft?.text ?? null, next_due: draft?.due ?? null, ...(ownerChanged && draft?.owner ? { owner: draft.owner } : {}),
  }) });
}
const message = (err: unknown) => (err instanceof Error ? err.message : "Could not save.");

/** The round tick. Ticking marks the action done; the next one is asked for straight away. */
export function CheckButton({ done = false, empty = false, label, onClick, small = false }: { done?: boolean; empty?: boolean; label: string; onClick?: () => void; small?: boolean }) {
  const mark = <span className={`${css.check} ${done ? css.checkDone : ""} ${empty ? css.checkEmpty : ""}`}><Check size={small ? 10 : 12} strokeWidth={3} aria-hidden /></span>;
  if (!onClick) return <span className={`${css.checkHit} ${small ? css.small : ""}`} aria-hidden>{mark}</span>;
  return <button type="button" aria-label={label} title={label} onClick={(event) => { event.stopPropagation(); onClick(); }} className={`${css.checkHit} ${small ? css.small : ""}`}>{mark}</button>;
}

/** The due pill. Opens Today, Tomorrow, in 3 days, next Monday, a date and Clear date. */
export function DuePicker({ due, today, onChange }: { due: string | null; today: string; onChange: (day: string | null) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", escape); };
  }, [open]);
  async function pick(day: string | null) {
    setBusy(true);
    try { await onChange(day); setOpen(false); } finally { setBusy(false); }
  }
  const label = dueLabel(due, today);
  return (
    <span ref={ref} className={css.popWrap} onClick={(event) => event.stopPropagation()}>
      <button type="button" className={css.due} data-tone={label.tone ?? undefined} aria-haspopup="menu" aria-expanded={open}
        aria-label={`Due: ${label.text}. Change date`} disabled={busy} onClick={() => setOpen(!open)}>
        {label.text}<ChevronDown size={12} aria-hidden />
      </button>
      {open && (
        <div role="menu" className={css.popover}>
          {quickDays(today).map((quick) => (
            <button key={quick.day} type="button" role="menuitem" className={css.menuItem} onClick={() => void pick(quick.day)}>
              {quick.label}<small>{quick.label === "Today" || quick.label === "Tomorrow" ? weekdayDay(quick.day) : ""}</small>
            </button>
          ))}
          <div className={css.sep} />
          <label className="block px-1 pb-1 text-[12px]" style={{ color: "var(--bt-muted)" }}>
            <span className="mb-1 block px-1">Pick a date</span>
            <input type="date" className={css.dateInput} min={today} value={due ?? ""} onChange={(event) => event.target.value && void pick(event.target.value)} />
          </label>
          {due && <><div className={css.sep} /><button type="button" role="menuitem" className={css.menuItem} onClick={() => void pick(null)}>Clear date</button></>}
        </div>
      )}
    </span>
  );
}

/** Text, when (quick days or a date) and who drives it. Save is always visible; Enter saves too. */
export function NextComposer({ today, owner, label, placeholder, submitLabel, onSubmit, onSkip, skipLabel = "Skip for now", autoFocus = false, compact = false }: {
  today: string; owner: DealOwner | null; label?: string; placeholder: string; submitLabel: string;
  onSubmit: (draft: Draft, ownerChanged: boolean) => Promise<void>; onSkip?: () => Promise<void>; skipLabel?: string; autoFocus?: boolean; compact?: boolean;
}) {
  const [text, setText] = useState("");
  const [due, setDue] = useState<string | null>(addDays(today, 1));
  const [driver, setDriver] = useState<DealOwner | null>(owner);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fieldId = useId();
  const quick = quickDays(today);
  const custom = due && !quick.some((q) => q.day === due) ? due : null;
  const ready = !!text.trim() && !!driver && !busy;
  async function run(fn: () => Promise<void>) {
    setBusy(true); setError(null);
    try { await fn(); } catch (err) { setError(message(err)); setBusy(false); }
  }
  const submit = () => ready && void run(() => onSubmit({ text: text.trim().slice(0, 300), due, owner: driver }, driver !== owner));
  return (
    <div className={css.composer} onClick={(event) => event.stopPropagation()}>
      {label && <label className={css.label} htmlFor={fieldId}>{label}</label>}
      <input id={fieldId} aria-label={label ? undefined : "Next action"} className={css.field} value={text} maxLength={300}
        autoFocus={autoFocus} placeholder={placeholder} onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); submit(); } }} />
      <div className={css.controlsRow}>
        <div className={css.quick} role="group" aria-label="Due">
          {quick.map((q) => <button key={q.day} type="button" aria-pressed={due === q.day} onClick={() => setDue(q.day)}>{q.label}</button>)}
          <span className={css.quickDate}>
            <button type="button" tabIndex={-1} aria-pressed={!!custom}>{custom ? shortDue(custom, today) : "Date…"}</button>
            <input type="date" aria-label="Pick a date" min={today} value={custom ?? ""} onChange={(event) => event.target.value && setDue(event.target.value)} />
          </span>
        </div>
        {(!compact || !owner) && (
          <select aria-label="Driver" className={`${css.select} ${driver ? "" : css.selectMissing}`} value={driver ?? ""}
            onChange={(event) => setDriver(dealOwner(event.target.value))}>
            {!driver && <option value="">Pick driver</option>}
            {DEAL_OWNERS.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        )}
        <span className={css.spacer} />
        {onSkip && <button type="button" className={css.ghost} disabled={busy} onClick={() => void run(onSkip)}>{skipLabel}</button>}
        <button type="button" className={css.primary} disabled={!ready} onClick={submit}>{busy ? "Saving…" : submitLabel}</button>
      </div>
      {error && <p role="alert" className={css.error}>{error}</p>}
    </div>
  );
}

/** The action text; click to change the wording in place (Enter saves, Escape cancels). */
function EditableText({ value, onSave }: { value: string; onSave: (text: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const saving = useRef(false);
  async function commit() {
    if (saving.current) return;
    const next = draft.trim();
    if (!next || next === value) { setEditing(false); return; }
    saving.current = true;
    try { await onSave(next.slice(0, 300)); setEditing(false); } catch (err) { setError(message(err)); } finally { saving.current = false; }
  }
  if (editing) {
    return <span className="flex flex-col gap-1">
      <input autoFocus aria-label="Next action" className={`${css.field} ${css.inlineField}`} value={draft} maxLength={300}
        onChange={(event) => setDraft(event.target.value)} onBlur={() => void commit()}
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void commit(); } if (event.key === "Escape") { event.preventDefault(); setEditing(false); } }} />
      {error && <span className={css.error}>{error}</span>}
    </span>;
  }
  return <button type="button" className={`${css.text} ${css.textButton}`} aria-label={`Edit next action: ${value}`} onClick={() => { setDraft(value); setError(null); setEditing(true); }}>
    <span className={css.textInner}>{value}</span><Pencil size={12} className={css.pencil} aria-hidden />
  </button>;
}

/**
 * The listing header's next action: what to do, when, and who. Tick it to log it done and say what comes next;
 * with none set, the add field is already open so the listing shows in Today.
 */
export function NextActionPanel({ listingId, value, today, onChanged }: { listingId: string; value: NextFields; today: string; onChanged?: () => void }) {
  const [state, setState] = useState(value);
  const [completing, setCompleting] = useState(false);
  useEffect(() => { setState(value); }, [value.next_action, value.next_due, value.owner]); // eslint-disable-line react-hooks/exhaustive-deps
  const after = (next: NextFields) => { setState(next); setCompleting(false); onChanged?.(); };
  const action = state.next_action;
  let body: React.ReactNode;
  if (completing && action) {
    body = <>
      <div className={css.doneLine}><CheckButton done small label="Done" /><s>{action}</s>
        <button type="button" className={css.link} onClick={() => setCompleting(false)}>Undo</button></div>
      <NextComposer autoFocus today={today} owner={state.owner} label="What's next?" placeholder="e.g. Send the EXW terms" submitLabel="Save"
        onSubmit={async (draft, ownerChanged) => { await postDone(listingId, action, draft, ownerChanged); after({ next_action: draft.text, next_due: draft.due, owner: draft.owner }); }}
        onSkip={async () => { await postDone(listingId, action, null, false); after({ ...state, next_action: null, next_due: null }); }} />
    </>;
  } else if (!action) {
    body = <>
      <p className={css.warn}><span className={css.dot} />No next action. Add one so it shows in Today.</p>
      <NextComposer today={today} owner={state.owner} placeholder="e.g. Call the seller to confirm the quantity" submitLabel="Add"
        onSubmit={async (draft, ownerChanged) => {
          if (ownerChanged && draft.owner) await putOwner(listingId, draft.owner);
          await putNext(listingId, draft.text, draft.due);
          after({ next_action: draft.text, next_due: draft.due, owner: draft.owner });
        }} />
    </>;
  } else {
    body = <div className={css.task}>
      <CheckButton label="Mark done" onClick={() => setCompleting(true)} />
      <div className={css.body}><EditableText value={action} onSave={async (text) => { await putNext(listingId, text, state.next_due); after({ ...state, next_action: text }); }} /></div>
      <div className={css.side}>
        <DuePicker due={state.next_due} today={today} onChange={async (day) => { await putNext(listingId, action, day); after({ ...state, next_due: day }); }} />
        <DriverAvatar owner={state.owner} size={24} />
      </div>
    </div>;
  }
  return <section aria-label="Next action" className={`${css.root} ${css.well}`} data-next-action>
    <h3 className={css.wellHead}>Next action</h3>
    <div className={css.tile}>{body}</div>
  </section>;
}

/** A Today row: tick, the action (opens the listing), where it belongs, due pill and driver. */
export function TodayTask({ id, value, kind, where, today, onOpen, onUpdate }: {
  id: string; value: NextFields; kind: string; where: string; today: string;
  onOpen: () => void; onUpdate: (next: NextFields) => void;
}) {
  const [mode, setMode] = useState<"view" | "completing" | "adding">("view");
  const action = value.next_action;
  const done = (next: NextFields) => { setMode("view"); onUpdate(next); };
  const whereLine = <div className={css.meta}><span className={css.kind}>{kind}</span>{where}</div>;
  return (
    <li className={`${css.root} ${css.item}`} data-task={id}>
      {mode === "completing" && action ? <>
        <div className={css.doneLine} style={{ margin: 0, padding: 0, border: 0 }}><CheckButton done small label="Done" /><s>{action}</s>
          <button type="button" className={css.link} onClick={() => setMode("view")}>Undo</button></div>
        <div className={css.inlineComposer}>
          <NextComposer autoFocus compact today={today} owner={value.owner} placeholder={`What's next on ${where}?`} submitLabel="Save"
            onSubmit={async (draft, ownerChanged) => { await postDone(id, action, draft, ownerChanged); done({ next_action: draft.text, next_due: draft.due, owner: draft.owner }); }}
            onSkip={async () => { await postDone(id, action, null, false); done({ ...value, next_action: null, next_due: null }); }} />
        </div>
      </> : (
        <div className={css.task}>
          {action ? <CheckButton label="Mark done" onClick={() => setMode("completing")} /> : <CheckButton empty label="Add next action" onClick={() => setMode("adding")} />}
          <div className={css.body}>
            {action
              ? <button type="button" className={`${css.text} ${css.rowText} ${css.textButton}`} title={`Open ${where}`} onClick={onOpen}><span className={css.textInner}>{action}</span></button>
              : <button type="button" className={`${css.text} ${css.rowText} ${css.placeholder}`} onClick={() => setMode(mode === "adding" ? "view" : "adding")}>Add next action…</button>}
            {whereLine}
          </div>
          <div className={css.side}>
            {action && <DuePicker due={value.next_due} today={today} onChange={async (day) => { await putNext(id, action, day); onUpdate({ ...value, next_due: day }); }} />}
            <DriverAvatar owner={value.owner} size={22} />
            <button type="button" aria-label={`Open ${where}`} className={css.chev} onClick={onOpen}><ChevronRight size={16} aria-hidden /></button>
          </div>
        </div>
      )}
      {mode === "adding" && !action && (
        <div className={css.inlineComposer}>
          <NextComposer autoFocus compact today={today} owner={value.owner} placeholder={`Next action for ${where}`} submitLabel="Add"
            onSubmit={async (draft, ownerChanged) => {
              if (ownerChanged && draft.owner) await putOwner(id, draft.owner);
              await putNext(id, draft.text, draft.due);
              done({ next_action: draft.text, next_due: draft.due, owner: draft.owner });
            }} />
        </div>
      )}
    </li>
  );
}
