"use client";

// The editable Criteria list on a request's Matches tab (mockup: Criteria Editor v4). One row per criterion the matches
// are filtered by, each tagged Buyer (stated by the buyer) or Ours (our own filter). Clicking a value edits it in place;
// Save, Remove and Undo write the request's own fields through the same PATCH the Details tab uses, then the matches
// refresh. Pure rules (validation, the PATCH body) live in lib/demand-criteria.ts.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ChevronDown, Pencil, Plus, Trash2, X } from "lucide-react";
import type { MatchCriteria } from "@/lib/matches-types";
import type { Registry } from "@/lib/bulk-registry";
import { COUNTRIES, REGIONS, REGION_NOTE } from "@/lib/demand-regions";
import {
  addable, CRITERIA, CURRENCIES, DEFS, describe, draftFor, patchFor, PRICE_UNITS, QTY_UNITS, readCriteria, validateDraft,
  type CriterionKey, type Options, type PatchBody, type Price, type Qty, type Range, type Value,
} from "@/lib/demand-criteria";
import { useRegistry } from "./use-registry";
import css from "./criteria-panel.module.css";
import shared from "./request-matches.module.css";

type Editing = { key: CriterionKey; isNew: boolean; draft: Value };
type Removed = { key: CriterionKey; prev: Value; before: CriterionKey | null };

export type CriteriaPanelProps = {
  criteria: MatchCriteria;
  registry: Registry | null;
  /** Saves the PATCH body, reloads the matches and resolves with the new lot count; rejects with a readable message. */
  save: (body: PatchBody) => Promise<{ lots: number | null }>;
};

const lower = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
const tagLabel = (owner: "buyer" | "ours") => (owner === "ours" ? "Ours" : "Buyer");

/** The values a list editor offers: the registry's, plus anything the request already holds that the registry lacks. */
function optionsFor(def: (typeof CRITERIA)[number], registry: Registry | null, held: string[]): string[] {
  const fromRegistry = (def.spec && registry?.specLists[def.spec]) || [];
  return [...new Set([...fromRegistry, ...held])];
}

/** The panel with the attribute registry loaded from the app (only mounted once Criteria is opened). */
export function LiveCriteriaPanel(props: Omit<CriteriaPanelProps, "registry">) {
  return <CriteriaPanel {...props} registry={useRegistry()} />;
}

export function CriteriaPanel({ criteria, registry, save }: CriteriaPanelProps) {
  const values = useMemo(() => readCriteria(criteria), [criteria]);
  const options: Options = useMemo(() => ({ lists: registry?.specLists ?? {} }), [registry]);
  const [ed, setEd] = useState<Editing | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [removed, setRemoved] = useState<Removed | null>(null);
  const [toast, setToast] = useState<{ message: string; undo: boolean } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [focus, setFocus] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const shown = CRITERIA.filter((def) => def.key in values || ed?.key === def.key);

  // Focus returns to the row's value (or the Add button) after a save or cancel.
  useEffect(() => {
    if (!focus) return;
    root.current?.querySelector<HTMLElement>(`[data-focus="${focus}"]`)?.focus();
    setFocus(null);
  }, [focus, values, ed, removed]);

  // Close the Add menu on an outside click.
  useEffect(() => {
    if (!menuOpen) return;
    const away = (event: MouseEvent) => {
      if (!(event.target as HTMLElement).closest("[data-add-area]")) setMenuOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [menuOpen]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const announce = (message: string, undo: boolean) => {
    setToast({ message, undo });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { setToast(null); setRemoved(null); }, 10_000);
  };
  const pauseToast = () => { if (timer.current) clearTimeout(timer.current); };
  const resumeToast = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { setToast(null); setRemoved(null); }, 10_000);
  };

  const lotsText = (lots: number | null) => (lots == null ? "" : ` · ${lots.toLocaleString("en-GB")} lots`);

  async function write(body: PatchBody) {
    setBusy(true);
    setSaveError(null);
    try {
      return await save(body);
    } finally {
      setBusy(false);
    }
  }

  const errorOf = (editing: Editing) => validateDraft(editing.key, editing.draft, values, options);

  /** Saves the open editor. Resolves false when it is invalid and stays open. */
  async function commit(editing: Editing): Promise<boolean> {
    const problem = errorOf(editing);
    if (problem === "empty") { setEd(null); setFocus(editing.isNew ? "add" : editing.key); return true; }
    if (problem) return false;
    const before = JSON.stringify(values[editing.key] ?? null);
    if (before === JSON.stringify(editing.draft)) { setEd(null); setFocus(editing.key); return true; }
    try {
      const { lots } = await write(patchFor(editing.key, editing.draft, criteria, options));
      setEd(null);
      setRemoved(null);
      setFocus(editing.key);
      announce(`${DEFS[editing.key].label} saved${lotsText(lots)}`, false);
      return true;
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Could not save.");
      return false;
    }
  }

  async function startEdit(key: CriterionKey, isNew: boolean) {
    if (ed && ed.key !== key && !(await commit(ed))) return;
    setEd({ key, isNew, draft: draftFor(key, values[key], criteria) });
    setSaveError(null);
  }

  function cancel() {
    if (!ed) return;
    const key = ed.key;
    setEd(null);
    setSaveError(null);
    setFocus(key in values ? key : "add");
  }

  async function remove(key: CriterionKey) {
    if (ed && ed.key !== key && !(await commit(ed))) return;
    const prev = values[key];
    if (prev === undefined) return;
    const keys = CRITERIA.map((def) => def.key).filter((k) => k in values);
    const before = keys[keys.indexOf(key) + 1] ?? null;
    try {
      const { lots } = await write(patchFor(key, null, criteria, options));
      setEd(null);
      setRemoved({ key, prev, before });
      setFocus("undo");
      announce(`${DEFS[key].label} removed${lotsText(lots)}`, true);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Could not remove.");
    }
  }

  async function undo() {
    if (!removed) return;
    const { key, prev } = removed;
    try {
      await write(patchFor(key, prev, criteria, options));
      setRemoved(null);
      setToast(null);
      setFocus(key);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Could not undo.");
    }
  }

  const undoRow = removed && (
    <div className={css.undoRow} key="undo-row">
      <span>{DEFS[removed.key].label} removed</span>
      <button type="button" className={shared.btn} data-focus="undo" onClick={() => void undo()} disabled={busy}>Undo</button>
    </div>
  );

  function menuKeys(event: ReactKeyboardEvent<HTMLDivElement>) {
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>("[role=menuitem]")];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => { event.preventDefault(); items[(i + items.length) % items.length]?.focus(); };
    if (event.key === "ArrowDown") go(at + 1);
    else if (event.key === "ArrowUp") go(at - 1);
    else if (event.key === "Home") go(0);
    else if (event.key === "End") go(items.length - 1);
    else if (event.key === "Escape" || event.key === "Tab") { event.preventDefault(); setMenuOpen(false); setFocus("add"); }
    else if (event.key.length === 1) {
      const letter = event.key.toLowerCase();
      const next = items.find((item, i) => i > at && item.textContent?.toLowerCase().startsWith(letter)) ?? items.find((item) => item.textContent?.toLowerCase().startsWith(letter));
      next?.focus();
    }
  }

  const free = addable(values);
  const menuSection = (title: string, defs: typeof free.buyer) => defs.length > 0 && (
    <>
      <div className={css.sect} role="presentation">{title}</div>
      {defs.map((def) => (
        <button key={def.key} type="button" role="menuitem" tabIndex={-1} className={css.mi}
          onClick={() => { setMenuOpen(false); void startEdit(def.key, true); }}>{def.label}</button>
      ))}
    </>
  );

  return (
    <div className={css.panel} ref={root} id="request-matches-criteria">
      <div>
        {shown.map((def) => {
          const editing = ed?.key === def.key ? ed : null;
          const value = values[def.key];
          const parts = describe(def.key, value);
          const chips = def.kind === "multi" || def.kind === "countries" || def.kind === "regions";
          const tag = <span className={`${css.tag} ${def.owner === "ours" ? css.ours : ""}`} title={def.owner === "ours" ? "Our filter" : "The buyer stated this"}>{tagLabel(def.owner)}</span>;
          const row = editing ? (
            <div className={`${css.r} ${css.editing}`} key={def.key} data-key={def.key}
              onKeyDown={(event) => {
                if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); cancel(); }
                else if (event.key === "Enter" && (event.target as HTMLElement).tagName === "INPUT" && !(event.target as HTMLElement).hasAttribute("data-search")) {
                  event.preventDefault();
                  void commit(editing);
                }
              }}>
              <span className={css.k} id={`crit-lab-${def.key}`}>{def.label} {tag}</span>
              <div className={css.ed}>
                <Editor editing={editing} registry={registry} held={Array.isArray(value) ? (value as string[]) : []} onChange={(draft) => setEd({ ...editing, draft })} />
                {(() => {
                  const problem = errorOf(editing);
                  const message = saveError ?? (problem && problem !== "empty" ? problem : null);
                  return <div className={css.error} role={message ? "alert" : undefined} hidden={!message}>{message}</div>;
                })()}
                <div className={css.edActs}>
                  <button type="button" className={`${shared.btn} ${css.dark}`} disabled={!!errorOf(editing) || busy} onClick={() => void commit(editing)}>
                    {busy ? "Saving…" : "Save"}
                  </button>
                  <button type="button" className={shared.btn} onClick={cancel}>Cancel</button>
                </div>
              </div>
            </div>
          ) : (
            <div className={css.r} key={def.key} data-key={def.key}>
              <span className={css.k} id={`crit-lab-${def.key}`}>{def.label} {tag}</span>
              <button type="button" className={css.val} data-focus={def.key} onClick={() => void startEdit(def.key, false)}
                aria-label={`${def.label}: ${parts ? parts.join(", ") : "any"}. Edit`}>
                {parts ? (chips ? parts.map((part) => <span key={part} className={css.chip}>{part}</span>) : parts[0]) : <span className={css.none}>Any</span>}
              </button>
              <span className={css.acts}>
                <button type="button" className={`${css.icb} ${css.edit}`} aria-label={`Edit ${def.label}`} onClick={() => void startEdit(def.key, false)}><Pencil className={css.ic} aria-hidden /></button>
                <button type="button" className={`${css.icb} ${css.del}`} aria-label={`Remove ${def.label}`} disabled={busy} onClick={() => void remove(def.key)}><Trash2 className={css.ic} aria-hidden /></button>
              </span>
            </div>
          );
          return removed?.before === def.key ? [undoRow, row] : row;
        })}
        {removed && removed.before === null && undoRow}
      </div>
      <div className={css.add} data-add-area>
        <button type="button" className={`${shared.btn} ${shared.btnGhost}`} data-focus="add" aria-haspopup="menu" aria-expanded={menuOpen} aria-controls="criteria-add-menu"
          onClick={() => setMenuOpen(!menuOpen)}>
          <Plus className={css.ic} aria-hidden /> Add criterion
        </button>
        {menuOpen && (
          <div className={css.menu} id="criteria-add-menu" role="menu" aria-label="Add criterion" onKeyDown={menuKeys}
            ref={(el) => { el?.querySelector<HTMLElement>("[role=menuitem]")?.focus(); }}>
            {free.buyer.length + free.ours.length === 0
              ? <div className={css.sect}>All criteria in use</div>
              : <>{menuSection("From the buyer", free.buyer)}{menuSection("Our filters", free.ours)}</>}
          </div>
        )}
      </div>
      {toast && (
        <div className={css.toast} role="status" aria-live="polite" onMouseEnter={pauseToast} onMouseLeave={resumeToast} onFocus={pauseToast} onBlur={resumeToast}>
          <span>{toast.message}</span>
          {toast.undo && removed && <button type="button" onClick={() => void undo()} disabled={busy}>Undo</button>}
        </div>
      )}
    </div>
  );
}

function Editor({ editing, registry, held, onChange }: { editing: Editing; registry: Registry | null; held: string[]; onChange: (draft: Value) => void }) {
  const def = DEFS[editing.key];
  const labelled = `crit-lab-${def.key}`;
  const { draft } = editing;
  const input = (value: string, set: (next: string) => void, label: string, extra?: { placeholder?: string; suffix?: string; wide?: boolean }) => (
    <label className={`${css.field} ${extra?.wide ? css.wide : ""}`}>
      <span className={css.sr}>{label}</span>
      <input inputMode="decimal" value={value} placeholder={extra?.placeholder} aria-label={label} autoFocus onChange={(event) => set(event.target.value)} />
      {extra?.suffix && <span className={css.sfx}>{extra.suffix}</span>}
    </label>
  );

  switch (def.kind) {
    case "multi": {
      const chosen = draft as string[];
      const all = optionsFor(def, registry, held);
      return (
        <div className={css.pills} role="group" aria-labelledby={labelled}>
          {all.map((option, i) => (
            <button key={option} type="button" role="checkbox" aria-checked={chosen.includes(option)} className={css.pill} autoFocus={i === 0}
              onClick={() => onChange(chosen.includes(option) ? chosen.filter((x) => x !== option) : [...chosen, option])}>
              {def.no ? `No ${lower(option)}` : option}
            </button>
          ))}
        </div>
      );
    }
    case "num":
      return <div className={css.row}>{input(draft as string, onChange, def.label, { suffix: def.unit })}</div>;
    case "price": {
      const price = draft as Price;
      return (
        <div className={css.row}>
          <span>{def.sign}</span>
          <Segment label="Currency" options={CURRENCIES} value={price.cur} onChange={(cur) => onChange({ ...price, cur })} />
          {input(price.amt, (amt) => onChange({ ...price, amt }), `${def.label} amount`, { placeholder: "0.00", suffix: "per" })}
          <Segment label="Unit" options={PRICE_UNITS} value={price.unit} onChange={(unit) => onChange({ ...price, unit })} />
        </div>
      );
    }
    case "qty": {
      const qty = draft as Qty;
      return (
        <div className={css.row}>
          {input(qty.n, (n) => onChange({ ...qty, n }), "Total quantity")}
          <Segment label="Unit" options={QTY_UNITS} value={qty.unit} onChange={(unit) => onChange({ ...qty, unit })} />
        </div>
      );
    }
    case "range": {
      const range = draft as Range;
      return (
        <div className={css.row}>
          {input(range.min, (min) => onChange({ ...range, min }), "Minimum kWh per unit", { placeholder: "min", suffix: "kWh" })}
          <span>to</span>
          {input(range.max, (max) => onChange({ ...range, max }), "Maximum kWh per unit", { placeholder: "max", suffix: "kWh" })}
        </div>
      );
    }
    case "text":
      return (
        <div className={css.row}>
          <label className={`${css.field} ${css.wide}`}>
            <span className={css.sr}>{def.label}</span>
            <input value={draft as string} aria-label={def.label} placeholder="Tesla, Volvo" autoFocus onChange={(event) => onChange(event.target.value)} />
          </label>
          <span className={css.hint}>Separate makes with commas.</span>
        </div>
      );
    case "country1":
      return <Dropdown labelId={labelled} kind="country" multi={false} value={draft ? [draft as string] : []} onChange={(next) => onChange(next[0] ?? "")} />;
    case "countries":
      return <Dropdown labelId={labelled} kind="country" multi value={draft as string[]} onChange={onChange} />;
    case "regions":
      return <Dropdown labelId={labelled} kind="region" multi value={draft as string[]} onChange={onChange} />;
  }
}

function Segment({ label, options, value, onChange }: { label: string; options: string[]; value: string; onChange: (next: string) => void }) {
  const all = options.includes(value) ? options : [...options, value];
  return (
    <span className={css.seg} role="radiogroup" aria-label={label}>
      {all.map((option) => (
        <button key={option} type="button" role="radio" aria-checked={option === value} tabIndex={option === value ? 0 : -1} onClick={() => onChange(option)}
          onKeyDown={(event) => {
            const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
            if (!step) return;
            event.preventDefault();
            const next = all[(all.indexOf(option) + step + all.length) % all.length];
            onChange(next);
            (event.currentTarget.parentElement?.querySelectorAll("button")[all.indexOf(next)] as HTMLElement | undefined)?.focus();
          }}>{option}</button>
      ))}
    </span>
  );
}

type Group = { heading: string | null; items: { value: string; note?: string }[] };

/** A country or region picker: one list in a popover (searchable for countries), selected first, with chips for a multi pick. */
function Dropdown({ labelId, kind, multi, value, onChange }: { labelId: string; kind: "country" | "region"; multi: boolean; value: string[]; onChange: (next: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const id = `crit-dd-${kind}-${labelId}`;

  const groups: Group[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    const selected = value.map((v) => ({ value: v, note: kind === "region" ? REGION_NOTE[v as (typeof REGIONS)[number]] : undefined }));
    if (kind === "region") {
      const items = REGIONS.filter((r) => !value.includes(r)).map((r) => ({ value: r as string, note: REGION_NOTE[r] }));
      return [{ heading: null, items: [...selected, ...items] }];
    }
    const byRegion = REGIONS.map((region) => ({
      heading: region as string | null,
      items: COUNTRIES.filter((c) => c.region === region && !value.includes(c.name) && (!q || c.name.toLowerCase().includes(q) || region.toLowerCase().includes(q))).map((c) => ({ value: c.name })),
    }));
    const picked = selected.filter((s) => !q || s.value.toLowerCase().includes(q));
    return [{ heading: "Selected" as string | null, items: picked }, ...byRegion].filter((g) => g.items.length);
  }, [query, value, kind]);
  const flat = groups.flatMap((g) => g.items);

  useEffect(() => { setActive(0); }, [query, open]);

  const close = (focusTrigger: boolean) => { setOpen(false); setQuery(""); if (focusTrigger) trigger.current?.focus(); };
  const toggle = (item: string) => {
    if (!multi) { onChange([item]); close(true); return; }
    onChange(value.includes(item) ? value.filter((v) => v !== item) : [...value, item]);
  };
  const summary = !value.length ? null : multi && value.length > 2 ? `${value.slice(0, 2).join(", ")} +${value.length - 2}` : value.join(", ");
  const hintLine = kind === "region"
    ? `${value.length ? `${value.map((r) => `${r}: ${REGION_NOTE[r as (typeof REGIONS)[number]] ?? ""}`).join(". ")}. ` : ""}Lots with no known country stay in as Check.`
    : multi ? "Lots with no known country stay in as Check." : null;

  function keys(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!open) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
    else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (flat.length) setActive((i) => (i + (event.key === "ArrowDown" ? 1 : -1) + flat.length) % flat.length);
    } else if (event.key === "Enter" || (event.key === " " && event.target !== search.current)) {
      const item = flat[active];
      if (item) { event.preventDefault(); toggle(item.value); }
    }
  }

  let n = -1;
  return (
    <div className={css.dd} onKeyDown={keys}>
      <button type="button" ref={trigger} className={css.ddTrig} aria-haspopup="listbox" aria-expanded={open} aria-controls={`${id}-list`} aria-labelledby={labelId} autoFocus
        onClick={() => { if (open) close(true); else { setOpen(true); setTimeout(() => search.current?.focus(), 0); } }}
        onKeyDown={(event) => { if (!open && (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ")) { event.preventDefault(); setOpen(true); setTimeout(() => search.current?.focus(), 0); } }}>
        {summary ? <span>{summary}</span> : <span className={css.ph}>{kind === "region" ? "Choose…" : multi ? "Choose…" : "Choose a country"}</span>}
        <ChevronDown className={css.ic} aria-hidden />
      </button>
      {open && (
        <div className={css.ddPop}>
          {kind === "country" && (
            <label className={css.field}>
              <span className={css.sr}>Search</span>
              <input ref={search} data-search placeholder="Search countries" aria-controls={`${id}-list`} value={query} onChange={(event) => setQuery(event.target.value)} />
            </label>
          )}
          <div className={css.ddList} id={`${id}-list`} role="listbox" aria-multiselectable={multi || undefined} aria-labelledby={labelId}>
            {flat.length === 0 && <div className={css.ddEmpty}>No country matches “{query}”</div>}
            {groups.map((group) => (
              <div key={group.heading ?? "all"}>
                {group.heading && <div className={css.ddGrp} role="presentation">{group.heading}</div>}
                {group.items.map((item) => {
                  n += 1;
                  const selected = value.includes(item.value);
                  return (
                    <div key={item.value} role="option" aria-selected={selected} id={`${id}-o${n}`}
                      className={`${css.ddOpt} ${multi ? "" : css.single} ${n === active ? css.ddAct : ""}`}
                      onMouseDown={(event) => event.preventDefault()} onClick={() => toggle(item.value)}>
                      <span className={css.cb} aria-hidden />
                      <span>{item.value}{item.note && <small>{item.note}</small>}</span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
      {multi && value.length > 0 && (
        <div className={css.row}>
          {value.map((item) => (
            <span key={item} className={css.chipx}>{item}
              <button type="button" aria-label={`Remove ${item}`} onClick={() => onChange(value.filter((v) => v !== item))}><X className={css.ic} aria-hidden /></button>
            </span>
          ))}
        </div>
      )}
      {hintLine && <span className={css.hint}>{hintLine}</span>}
    </div>
  );
}
