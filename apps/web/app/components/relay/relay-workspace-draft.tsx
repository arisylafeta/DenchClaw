"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { RelayJob } from "@/lib/relay";
import type { SendOutcome, TalkDraft } from "@/lib/relay-talk";
import type { PriceFill } from "@/lib/relay-price-types";
import { SEND_MODES, type SendMode } from "@/lib/relay-talk-core";
import { londonInputValue, londonWallToUtc, sendAtProblem, sendLabel, sendSlots, undoSecondsLeft } from "@/lib/relay-send-time";
import {
  draftNeeds, fromEditable, isAddress, paragraphs, parsePrice, priceText, SEND_MODE_WORDS, sendGate, tabNote, toEditable, whenWords, type Piece,
} from "@/lib/relay-workspace-core";
import { ChevronDown, Pencil } from "lucide-react";
import { ThinkingIndicator } from "@/app/components/chat-native/thinking";
import { cx, failureText, firstOf } from "./relay-ui";
import { RecipientInput } from "./relay-recipients";
import type { SenderKey } from "@/lib/relay-senders";
import type { SendRun, StockView } from "./relay-workspace-work";
import w from "./relay-workspace.module.css";

export type SheetActions = {
  setPrice: (draftId: string, key: string, value: number | null) => Promise<boolean>;
  acceptPrice: (draftId: string, key: string) => Promise<void>;
  undo: (draftId: string, redo: boolean) => Promise<void>;
  setLinked: (draftId: string, patch: { included?: boolean; send_mode?: SendMode; send_at?: string | null }) => Promise<boolean>;
  sendAll: () => Promise<void>;
  undoAll: () => Promise<void>;
  toGmail: (d: TalkDraft) => Promise<void>;
  sendLater: (d: TalkDraft, at: string) => Promise<void>;
  cancelLater: (d: TalkDraft) => Promise<void>;
  saveGaps: (draftId: string) => Promise<unknown>;
  typeGap: (draftId: string, index: number, value: string) => void;
  /** Who the email is from: alex, buy or supply. Re-signs it as that sender. */
  setSender: (d: TalkDraft, key: SenderKey) => Promise<void>;
  /** Alex's own edit of the text, subject or recipients; true when it saved. */
  edit: (d: TalkDraft, changes: { body?: string; subject?: string; to?: string[]; cc?: string[]; bcc?: string[] }) => Promise<boolean>;
};

type Typed = Record<string, Record<number, string>>;
const isLocked = (d: TalkDraft) => d.state === "sent" || !d.mail || !!d.mail.scheduled || d.mail.state !== "draft";

/**
 * The emails from this conversation, one tab each (the reply first), with the reply's body as Alex will send it: lime
 * marks on Relay's last change, price fields and other gaps in the sentence, and the working in the margin only he sees.
 * Under it: the linked emails that go with the reply, and Send.
 */
export function DraftSheet({ drafts, current, onTab, name, typed, stock, busy, run, actions, job, jobNote, pendingFirst, hold }: {
  drafts: TalkDraft[]; current: TalkDraft | null; onTab: (id: string) => void; name: string; typed: Typed; stock: StockView | { error: string } | null;
  busy: "send" | "gmail" | "later" | "undo" | null; run: SendRun | null; actions: SheetActions; job: RelayJob | null; jobNote: string; pendingFirst: boolean;
  /** Relay's desk is changing these emails: Send, the prices, the gaps, Edit and Undo wait, and this says why. */
  hold: string | null;
}) {
  const shown = drafts.filter((d) => d.mail);
  const [marksOn, setMarksOn] = useState(true);
  if (!shown.length || !current?.mail) return <NoReply job={job} note={jobNote} writing={pendingFirst} name={name} />;
  const linked = shown.filter((d) => d.role === "follow");
  const primary = shown.find((d) => d.role === "primary") ?? null;
  return (
    <section className={w.sheet} aria-label="Emails from this conversation">
      <div className={w.tabs} role="tablist" aria-label="Email">
        {shown.map((d) => {
          const note = tabNote(d, draftNeeds(d.mail!.main, d.fills, typed[d.id]));
          return (
            <button key={d.id} type="button" role="tab" id={`relay-tab-${d.id}`} aria-controls="relay-draft-panel" aria-selected={d.id === current.id} className={w.tab} onClick={() => onTab(d.id)}>
              <b>{d.role === "primary" ? `Reply to ${firstOf(name)}` : d.title}</b>
              <span className={cx(note.tone === "warn" && w.warn, note.tone === "danger" && w.danger)}>{note.text}</span>
            </button>
          );
        })}
      </div>
      <Panel key={current.id} d={current} name={name} typed={typed[current.id] ?? {}} stock={current.role === "primary" && current.to_kind === "buyer" ? stock : null}
        marksOn={marksOn} onMarks={() => setMarksOn(!marksOn)} actions={actions} busy={busy} hold={hold} />
      {linked.length > 0 && <Linked drafts={linked} actions={actions} />}
      {(run || (primary && !isLocked(primary))) && <SendBar drafts={drafts} primary={primary} current={current} typed={typed} busy={busy} run={run} actions={actions} hold={hold} />}
    </section>
  );
}

function NoReply({ job, note, writing, name }: { job: RelayJob | null; note: string; writing: boolean; name: string }) {
  if (job && job.status === "failed") {
    return (
      <section className={cx(w.sheet, w.panel)} aria-label="The reply">
        <p className={w.error} role="alert">Relay couldn't finish the reply: {job.error ?? "something went wrong"}.</p>
        <p className={w.muted}>Tell Relay again on the right, maybe more simply, and it writes a quick one.</p>
      </section>
    );
  }
  if (writing || job) {
    return (
      <section className={cx(w.sheet, w.panel)} aria-label="The reply" aria-busy>
        <ThinkingIndicator>{job ? (job.status === "ready" || job.status === "finalising" ? "Writing the reply and attaching files" : "Researching before it writes. Usually 2 to 5 minutes") : "Writing the reply"}</ThinkingIndicator>
        {job && note && <p className={w.muted}>From your note: “{note}”</p>}
        {job?.steps.length ? <ol className={w.steps}>{job.steps.map((s, k) => <li key={k}>{s}</li>)}</ol> : null}
      </section>
    );
  }
  return (
    <section className={cx(w.sheet, w.panel, w.noReply)} aria-label="The reply">
      <b>No reply yet.</b>
      <span>Tell Relay how to answer {firstOf(name)}, and it writes the reply and any emails that go with it. Nothing is sent until you press Send.</span>
    </section>
  );
}

// ---------------------------------------------------------------- one email

function Panel({ d, name, typed, stock, marksOn, onMarks, actions, busy, hold }: {
  d: TalkDraft; name: string; typed: Record<number, string>; stock: StockView | { error: string } | null; marksOn: boolean; onMarks: () => void; actions: SheetActions;
  busy: string | null; hold: string | null;
}) {
  const mail = d.mail!;
  const locked = isLocked(d);
  const scheduled = mail.scheduled;
  const [, tick] = useState(0);
  useEffect(() => { if (!scheduled?.undo) return; const t = setInterval(() => tick((n) => n + 1), 500); return () => clearInterval(t); }, [scheduled?.undo]);
  const left = scheduled?.undo ? undoSecondsLeft(scheduled.at) : 0;

  const to = mail.to_emails.join(", ") || "nobody yet";
  const cc = mail.cc_emails.length ? `, copying ${mail.cc_emails.join(", ")}` : "";
  const head = d.role === "primary" ? `To ${to}${cc}.` : `To ${to}. ${whenWords(d)}.`;
  // Only a linked email to the other side of the deal needs the reminder: the reply goes to the person it's about.
  const guard = d.leaks.length || d.role !== "follow" ? null : d.to_kind === "supplier" ? `Never mentions ${firstOf(name)} or what we charge.` : d.to_kind === "buyer" ? "Never names the supplier or their cost." : null;
  const [editing, setEditing] = useState(false);

  if (editing) return (
    <div className={w.panel} role="tabpanel" id="relay-draft-panel" aria-labelledby={`relay-tab-${d.id}`}>
      <EditDraft d={d} onCancel={() => setEditing(false)} onSave={async (changes) => { if (await actions.edit(d, changes)) setEditing(false); }} />
    </div>
  );

  return (
    <div className={w.panel} role="tabpanel" id="relay-draft-panel" aria-labelledby={`relay-tab-${d.id}`}>
      <span className={w.toRow}>
        <span className={w.to}>
          {head}{d.role === "follow" && d.why ? ` ${d.why}` : ""}{" "}
          <FromPicker from={mail.from_email} locked={locked || !!busy} onPick={(key) => void actions.setSender(d, key)} />
        </span>
        {!locked && <button type="button" className={w.editBtn} disabled={!!hold} title={hold ?? undefined} onClick={() => setEditing(true)}><Pencil size={12} aria-hidden />Edit</button>}
      </span>
      {d.state === "sent" && <p className={w.status}>Sent.</p>}
      {scheduled && (
        <p className={w.status}>
          {scheduled.undo ? (left > 0 ? `Sending in ${left} s.` : "On its way.") : `Goes ${sendLabel(scheduled.at)}${scheduled.unless_reply ? ", unless they reply first" : ""}.`}
          {scheduled.undo && left > 0 && <button type="button" className={w.linkbtn} disabled={!!busy} onClick={() => void actions.undoAll()}>Undo</button>}
          {!scheduled.undo && <button type="button" className={w.linkbtn} disabled={!!busy} onClick={() => void actions.cancelLater(d)}>Cancel</button>}
        </p>
      )}
      {mail.failure && mail.state === "draft" && <p className={w.error} role="alert">The last try didn't go: {failureText(mail.failure, mail.state)}</p>}
      <Body d={d} typed={typed} stock={stock} locked={locked} hold={hold} marksOn={marksOn} onMarks={onMarks} actions={actions} />
      {d.leaks.map((leak, k) => <p key={k} className={w.error} role="alert">Can't go like this: {leak.text.replace(/^./, (c) => c.toLowerCase())} Ask Relay to take it out.</p>)}
      {guard && <span className={w.guard}>{guard}</span>}
    </div>
  );
}

type Note = { key: string; body: ReactNode };

/** The body in paragraphs, each with its notes in the margin: the last change with Undo, and each price's working. */
function Body({ d, typed, stock, locked, hold, marksOn, onMarks, actions }: {
  d: TalkDraft; typed: Record<number, string>; stock: StockView | { error: string } | null; locked: boolean; hold: string | null; marksOn: boolean; onMarks: () => void; actions: SheetActions;
}) {
  const root = useRef<HTMLDivElement>(null);
  const paras = paragraphs(d.mail!.main, marksOn && !locked ? d.marks : []);
  const notes: Note[][] = paras.map(() => []);
  const fillOf = (key: string) => d.fills.find((f) => f.key === key);

  // The last change, beside the first paragraph it touched.
  if (!locked && (d.change || d.undone)) {
    const marked = paragraphs(d.mail!.main, d.marks).findIndex((p) => p.some((x) => x.marked));
    const at = marked >= 0 ? Math.min(marked, paras.length - 1) : Math.min(1, paras.length - 1);
    const back = !!d.undone && !d.marks.length;
    const why = back ? "Back to how it was." : d.change?.by === "alex" ? "Your edit." : d.change?.by === "undo" ? "Put back." : d.change ? `Changed when you asked “${d.change.reason}”.` : "";
    notes[at].push({
      key: "change",
      body: (
        <span className={w.note}>
          <span>{why}</span>
          <span className={w.noteBtns}>
            {d.change && !back && <button type="button" className={w.linkbtn} disabled={!!hold} onClick={() => void actions.undo(d.id, false)}>Undo</button>}
            {d.undone && <button type="button" className={w.linkbtn} disabled={!!hold} onClick={() => void actions.undo(d.id, true)}>Redo</button>}
            {d.marks.length > 0 && <button type="button" className={w.linkbtn} aria-pressed={!marksOn} onClick={onMarks}>{marksOn ? "Hide marks" : "Show marks"}</button>}
          </span>
        </span>
      ),
    });
  }

  // Each price's working; the first one says the margin is Alex's alone.
  let firstPrice = -1;
  if (!locked) paras.forEach((p, k) => {
    for (const piece of p) {
      if (piece.kind !== "price") continue;
      if (firstPrice < 0) firstPrice = k;
      notes[k].push({ key: `price-${piece.key}`, body: <PriceNote fill={fillOf(piece.key)} locked={locked || !!hold} onUse={() => void actions.acceptPrice(d.id, piece.key)} /> });
    }
  });
  if (firstPrice >= 0) {
    const at = firstPrice > 0 && !notes[firstPrice - 1].length ? firstPrice - 1 : firstPrice;
    notes[at].unshift({ key: "private", body: <span className={w.private}>Only you see this side. It never goes in the email.</span> });
    // What else fits but isn't offered, after the last price.
    if (stock && !locked) {
      const offered = new Set(paras.flat().flatMap((x) => (x.kind === "price" ? [x.key] : [])));
      const lastPrice = paras.reduce((at2, p, k) => (p.some((x) => x.kind === "price") ? k : at2), firstPrice);
      const target = lastPrice + 1 < paras.length && !notes[lastPrice + 1].length ? lastPrice + 1 : lastPrice;
      if ("error" in stock) notes[target].push({ key: "stock", body: <span>{stock.error}</span> });
      else {
        const rest = stock.fits.filter((f) => !offered.has(f.key)).slice(0, 3);
        if (rest.length) {
          const line = rest.map((f) => {
            const price = stock.prices.find((p) => p.key === f.key)?.value;
            return `${f.label}${price != null ? ` at £${priceText(price)}` : ""} from ${f.supplier.name || "a supplier"}${f.soh != null ? `, state of health ${f.soh}%` : ""}`;
          }).join("; ");
          notes[target].push({ key: "stock", body: <span>Also fits, not offered: {line}.</span> });
        }
      }
    }
  }

  const next = (from: HTMLInputElement) => {
    const fields = Array.from(root.current?.querySelectorAll("input") ?? []);
    const after = fields[fields.indexOf(from) + 1];
    if (after) after.focus(); else from.blur();
  };

  const margin = notes.some((n) => n.length > 0);
  return (
    <div className={cx(w.doc, !margin && w.docSolo)} ref={root}>
      {paras.map((p, k) => (
        <Row key={k} notes={notes[k]} margin={margin}>
          {p.map((piece, j) => <PieceView key={j} piece={piece} d={d} typed={typed} locked={locked} hold={hold} fill={piece.kind === "price" ? fillOf(piece.key) : undefined} actions={actions} onNext={next} />)}
        </Row>
      ))}
    </div>
  );
}

function Row({ notes, margin, children }: { notes: Note[]; margin: boolean; children: ReactNode }) {
  return (
    <>
      <p className={w.para}>{children}</p>
      {notes.length ? <div className={w.side}>{notes.map((n) => <div key={n.key}>{n.body}</div>)}</div> : margin ? <span className={w.rail} aria-hidden /> : null}
    </>
  );
}

/**
 * Alex edits the email himself: who it goes to, the subject and the text. Relay's prices stay as "[price: …]" so they
 * are still filled at Send; a figure typed over one is his own. Saved as one change, so Undo can take it back.
 */
function EditDraft({ d, onCancel, onSave }: { d: TalkDraft; onCancel: () => void; onSave: (changes: Parameters<SheetActions["edit"]>[1]) => Promise<void> }) {
  const mail = d.mail!;
  const start = useRef(toEditable(mail.main));
  const [to, setTo] = useState(mail.to_emails);
  const [cc, setCc] = useState(mail.cc_emails);
  const [bcc, setBcc] = useState(mail.bcc_emails ?? []);
  const [showCc, setShowCc] = useState(mail.cc_emails.length > 0);
  const [showBcc, setShowBcc] = useState((mail.bcc_emails ?? []).length > 0);
  const [subject, setSubject] = useState(mail.subject ?? "");
  const [text, setText] = useState(start.current.text);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  // The box grows with the email, so the whole draft is in view while he edits.
  useEffect(() => { const el = area.current; if (el) { el.style.height = "auto"; el.style.height = `${el.scrollHeight + 2}px`; } }, [text]);
  useEffect(() => { area.current?.focus(); area.current?.setSelectionRange(0, 0); }, []);

  const same = (a: string[], b: string[]) => a.join(",") === b.join(",");
  const save = async () => {
    const bad = [...to, ...cc, ...bcc].find((a) => !isAddress(a));
    if (bad) { setProblem(`“${bad}” isn't an email address. Take it out or fix it.`); return; }
    if (!to.length) { setProblem("Add someone to send it to."); return; }
    setProblem(null);
    const changes: Parameters<SheetActions["edit"]>[1] = {};
    const body = fromEditable(text, start.current.markers);
    if (body !== mail.main) changes.body = body;
    if (subject !== (mail.subject ?? "")) changes.subject = subject;
    if (!same(to, mail.to_emails)) changes.to = to;
    if (!same(cc, mail.cc_emails)) changes.cc = cc;
    if (!same(bcc, mail.bcc_emails ?? [])) changes.bcc = bcc;
    if (!Object.keys(changes).length) { onCancel(); return; }
    setSaving(true);
    try { await onSave(changes); } finally { setSaving(false); }
  };
  const keys = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !e.defaultPrevented) onCancel();
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void save(); }
  };
  const hasPrices = Object.keys(start.current.markers).length > 0;

  return (
    <div className={w.editor} onKeyDown={keys}>
      <div className={w.heads}>
        <div className={w.headRow}>
          <RecipientInput label="To" value={to} onChange={setTo} />
          {(!showCc || !showBcc) && (
            <span className={w.ccLinks}>
              {!showCc && <button type="button" onClick={() => setShowCc(true)}>Cc</button>}
              {!showBcc && <button type="button" onClick={() => setShowBcc(true)}>Bcc</button>}
            </span>
          )}
        </div>
        {showCc && <div className={w.headRow}><RecipientInput label="Cc" value={cc} onChange={setCc} autoFocus={!mail.cc_emails.length} /></div>}
        {showBcc && <div className={w.headRow}><RecipientInput label="Bcc" value={bcc} onChange={setBcc} autoFocus={!(mail.bcc_emails ?? []).length} /></div>}
        {d.role === "follow" && (
          <label className={w.headRow}><span className={w.rcptLabel}>Subject</span><input className={w.subject} value={subject} onChange={(e) => setSubject(e.target.value)} /></label>
        )}
      </div>
      <label className={w.bodyField}>
        <span className={w.srOnly}>The email</span>
        <textarea ref={area} value={text} onChange={(e) => setText(e.target.value)} rows={8} />
      </label>
      {hasPrices && <span className={w.hint}>Relay&apos;s prices show as [price: …] and go in at Send. Type a figure over one to set your own.</span>}
      {problem && <p className={w.error} role="alert">{problem}</p>}
      <span className={w.editBtns}>
        <button type="button" className={w.saveBtn} disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</button>
        <button type="button" className={w.cancelBtn} disabled={saving} onClick={onCancel}>Cancel</button>
        <span className={w.hint}>⌘ Enter saves · Esc cancels</span>
      </span>
    </div>
  );
}

function PieceView({ piece, d, typed, locked, hold, fill, actions, onNext }: {
  piece: Piece; d: TalkDraft; typed: Record<number, string>; locked: boolean; hold: string | null; fill: PriceFill | undefined; actions: SheetActions; onNext: (from: HTMLInputElement) => void;
}) {
  if (piece.kind === "text") return piece.marked ? <span className={w.mark}>{piece.text}</span> : <>{piece.text}</>;
  if (piece.kind === "price") {
    if (locked) return <span className={piece.marked ? w.mark : undefined}>{fill?.value != null ? `£${priceText(fill.value)}` : "[price]"}</span>;
    return <PriceField key={`${piece.key}:${fill?.value ?? ""}:${fill?.by ?? ""}`} label={piece.label} fill={fill} marked={piece.marked} hold={hold}
      onSave={(value) => actions.setPrice(d.id, piece.key, value)} onNext={onNext} />;
  }
  const value = typed[piece.index] ?? "";
  if (locked) return <span>[{piece.label || "gap"}]</span>;
  const label = piece.label || "fill in";
  return (
    <input className={cx(w.field, w.gap, value.trim() && w.filled, piece.marked && w.fieldMarked)} value={value} placeholder={label} aria-label={`Fill in: ${label}`}
      disabled={!!hold} title={hold ?? undefined}
      style={{ width: `${Math.min(44, Math.max(7, (value || label).length + 2))}ch` }}
      onChange={(e) => actions.typeGap(d.id, piece.index, e.target.value)} onBlur={() => void actions.saveGaps(d.id)}
      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onNext(e.currentTarget); } }} />
  );
}

/** A price in the sentence: Relay's in yellow until Alex changes or keeps it, his own plain, an empty one dashed. */
function PriceField({ label, fill, marked, hold, onSave, onNext }: {
  label: string; fill: PriceFill | undefined; marked: boolean; hold: string | null; onSave: (value: number | null) => Promise<boolean>; onNext: (from: HTMLInputElement) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const [bad, setBad] = useState<string | null>(null);
  const saving = useRef(false);
  const shown = text ?? priceText(fill?.value);
  // Typing makes it his; until then it is whoever set it last.
  const state = !shown.trim() ? w.pEmpty : text != null || fill?.by === "alex" ? w.pAlex : w.pRelay;
  const commit = async () => {
    if (text == null || saving.current) return;
    const parsed = parsePrice(text);
    if ("error" in parsed) { setBad(parsed.error); return; }
    setBad(null);
    // The same figure again changes nothing: keeping Relay's price is "Use this price".
    if (parsed.value === (fill?.value ?? null)) { setText(null); return; }
    saving.current = true;
    const ok = await onSave(parsed.value);
    saving.current = false;
    if (ok) setText(null);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") { e.preventDefault(); onNext(e.currentTarget); }
    if (e.key === "Escape") { setText(null); setBad(null); }
  };
  return (
    <span className={cx(w.price, state, marked && w.fieldMarked)} title={bad ?? hold ?? undefined}>
      £<input value={shown} disabled={!!hold} inputMode="decimal" placeholder="price" aria-label={`Price for ${label}${fill?.basis ? `, ${fill.basis}` : ""}`} aria-invalid={!!bad || undefined}
        style={{ width: `${Math.max(5, shown.length + 1)}ch` }} onChange={(e) => setText(e.target.value)} onBlur={() => void commit()} onKeyDown={onKey} />
    </span>
  );
}

function PriceNote({ fill, locked, onUse }: { fill: PriceFill | undefined; locked: boolean; onUse: () => void }) {
  if (!fill) return <span className={w.note}><b>No price yet</b><span>Relay hasn't priced this line. Type yours, or ask Relay to re-price.</span></span>;
  const relay = fill.by === "relay";
  return (
    <span className={w.note}>
      <b>{fill.value == null ? "No price yet" : relay ? "Relay’s price" : "Your price"}{fill.value != null ? `, ${fill.basis}` : ""}</b>
      {fill.working.map((line, k) => <span key={k}>{line}</span>)}
      {fill.needsDeliveryQuote && <span className={w.warnLine}>Delivered needs a quote from the transport partner.</span>}
      {fill.warnings.map((line, k) => <span key={`w${k}`} className={w.warnLine}>{line}</span>)}
      {relay && fill.value != null && !locked && <button type="button" className={w.linkbtn} onClick={onUse}>Use this price</button>}
    </span>
  );
}

// ---------------------------------------------------------------- linked emails

/** "Goes with this reply": each linked email with a tick, when it goes and how. */
function Linked({ drafts, actions }: { drafts: TalkDraft[]; actions: SheetActions }) {
  return (
    <div className={w.linked}>
      <h3>Goes with this reply</h3>
      {drafts.map((d) => <LinkedRow key={d.id} d={d} actions={actions} />)}
    </div>
  );
}

function LinkedRow({ d, actions }: { d: TalkDraft; actions: SheetActions }) {
  const locked = isLocked(d);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [time, setTime] = useState(() => (d.send_at ? londonInputValue(new Date(d.send_at)) : ""));
  const [bad, setBad] = useState<string | null>(null);
  useEffect(() => { setTime(d.send_at ? londonInputValue(new Date(d.send_at)) : ""); }, [d.send_at]);
  const change = async (patch: Parameters<SheetActions["setLinked"]>[1]) => { setBusy(true); await actions.setLinked(d.id, patch); setBusy(false); };
  const pickMode = (mode: SendMode) => {
    const timed = mode === "at" || mode === "unless_reply";
    void change(timed ? { send_mode: mode, send_at: d.send_at ?? sendSlots()[0].at } : { send_mode: mode });
  };
  const commitTime = () => {
    if (!time) return;
    const [date, clock] = time.split("T");
    const at = londonWallToUtc(date, clock);
    const problem = londonInputValue(at) !== time ? "That time doesn't exist in London: the clocks change then." : sendAtProblem(at);
    setBad(problem);
    if (!problem && at.toISOString() !== (d.send_at && new Date(d.send_at).toISOString())) void change({ send_at: at.toISOString() });
  };
  const id = `relay-linked-${d.id}`;
  const timed = d.send_mode === "at" || d.send_mode === "unless_reply";
  return (
    <div className={w.lrow}>
      <input type="checkbox" id={id} checked={d.state === "sent" || d.included} disabled={locked || busy} onChange={() => void change({ included: !d.included })} />
      <label htmlFor={id} className={cx(w.ltitle, !d.included && d.state !== "sent" && w.off)}>{d.title}{d.why && <span>{d.why}</span>}</label>
      {d.state === "sent" ? <span className={w.lwhen}>Sent</span>
        : d.mail?.scheduled ? <span className={w.lwhen}>{tabNote(d, { emptyPrices: 0, otherGaps: 0, relayPrices: 0, alexPrices: 0 }).text}</span>
        : <button type="button" className={w.lwhenBtn} aria-expanded={editing} aria-label={`When “${d.title}” goes: ${whenWords(d)}. Change`} onClick={() => setEditing(!editing)}>{whenWords(d)}</button>}
      {editing && !locked && (
        <span className={w.ledit}>
          <select className={w.select} value={d.send_mode} disabled={busy} aria-label={`How “${d.title}” goes`} onChange={(e) => pickMode(e.target.value as SendMode)}>
            {SEND_MODES.map((m) => <option key={m} value={m}>{SEND_MODE_WORDS[m]}</option>)}
          </select>
          {timed && (
            <input type="datetime-local" className={w.select} value={time} disabled={busy} aria-label={`Time for “${d.title}”, London`} aria-invalid={!!bad || undefined}
              onChange={(e) => setTime(e.target.value)} onBlur={commitTime} />
          )}
          <button type="button" className={w.linkbtn} onClick={() => { commitTime(); setEditing(false); }}>Done</button>
        </span>
      )}
      {bad && <span className={w.badLine} role="alert">{bad}</span>}
    </div>
  );
}

// ---------------------------------------------------------------- Send

function SendBar({ drafts, primary, current, typed, busy, run, actions, hold }: {
  drafts: TalkDraft[]; primary: TalkDraft | null; current: TalkDraft; typed: Typed; busy: string | null; run: SendRun | null; actions: SheetActions; hold: string | null;
}) {
  const gate = sendGate(drafts, typed);
  const [later, setLater] = useState(false);
  const [custom, setCustom] = useState("");
  const [bad, setBad] = useState<string | null>(null);
  const [, tick] = useState(0);
  const counting = !!run && run.until > Date.now();
  useEffect(() => { if (!counting) return; const t = setInterval(() => tick((n) => n + 1), 500); return () => clearInterval(t); }, [counting]);

  const replyGate = primary ? sendGate([primary], typed) : null;
  const currentNeeds = current.mail ? draftNeeds(current.mail.main, current.fills, typed[current.id]) : null;
  const gmailReady = !isLocked(current) && !!currentNeeds && !currentNeeds.emptyPrices && !currentNeeds.otherGaps && !current.leaks.length;
  const pickLater = (at: string) => { setLater(false); if (primary) void actions.sendLater(primary, at); };
  const scheduleCustom = () => {
    if (!custom) return;
    const [date, clock] = custom.split("T");
    const at = londonWallToUtc(date, clock);
    const problem = londonInputValue(at) !== custom ? "That time doesn't exist in London: the clocks change then." : sendAtProblem(at);
    setBad(problem);
    if (!problem) pickLater(at.toISOString());
  };
  const left = run ? undoSecondsLeft(new Date(run.until)) : 0;

  return (
    <>
      {primary && !isLocked(primary) && <div className={w.sendbar}>
        <button type="button" className={w.send} disabled={!gate.ready || !!busy || !!hold} aria-describedby="relay-gate" onClick={() => void actions.sendAll()}>
          {busy === "send" ? "Sending…" : gate.label}
        </button>
        <span id="relay-gate" className={cx(w.gate, (!!hold || gate.tone === "ok") && w.ok, !hold && gate.tone === "danger" && w.danger)}>{hold ?? gate.line}</span>
        <span className={w.secondary}>
          <button type="button" className={w.ghost} disabled={!gmailReady || !!busy || !!hold} title={gmailReady ? undefined : "Fill the gaps first"} onClick={() => void actions.toGmail(current)}>
            {busy === "gmail" ? "Putting it in Gmail…" : current.state === "gmail" ? "Update in Gmail drafts" : "Put in Gmail drafts"}
          </button>
          <button type="button" className={w.ghost} aria-expanded={later} disabled={!replyGate?.ready || !!busy || !!hold} onClick={() => setLater(!later)}>Send later<ChevronDown size={13} aria-hidden className={w.laterChevron} /></button>
          {later && (
            <div className={w.menu} role="dialog" aria-label="Send the reply later">
              <span className={w.menuNote}>The reply only. Linked emails stay as drafts.</span>
              {sendSlots().map((s) => <button key={s.at} type="button" onClick={() => pickLater(s.at)}>{s.label}</button>)}
              <label className={w.menuCustom}>
                <span>Or pick a time, London</span>
                <input type="datetime-local" className={w.select} value={custom} onChange={(e) => setCustom(e.target.value)} aria-invalid={!!bad || undefined} />
              </label>
              {bad && <span className={w.badLine} role="alert">{bad}</span>}
              <button type="button" className={w.menuGo} disabled={!custom} onClick={scheduleCustom}>Schedule</button>
            </div>
          )}
        </span>
      </div>}
      {run && (
        <ul className={cx(w.results, primary && isLocked(primary) && w.resultsOnly)} aria-live="polite">
          {run.results.map((r) => <li key={r.draftId} className={cx(r.outcome === "failed" && w.badLine)}><b>{r.title}</b>: {outcomeWords(r, left)}</li>)}
          {left > 0 && <li><button type="button" className={w.linkbtn} disabled={!!busy} onClick={() => void actions.undoAll()}>Undo all ({left} s)</button></li>}
        </ul>
      )}
    </>
  );
}

const outcomeWords = (r: SendOutcome, left: number) => {
  if (r.outcome === "queued") return left > 0 ? `sending in ${left} s` : "sending";
  if (r.outcome === "scheduled") return r.at ? `goes ${sendLabel(r.at)}` : "scheduled";
  if (r.outcome === "todo") return "a to-do for when they order";
  if (r.outcome === "cancelled") return "stopped";
  return `not sent. ${r.why ?? "Try it on its own."}`;
};

/** Who can reply, in the order Alex uses them. Each is a "Send mail as" address of his Gmail. */
const FROM: { key: SenderKey; address: string }[] = [
  { key: "alex", address: "alex@rebattery.io" },
  { key: "buy", address: "buy@rebattery.io" },
  { key: "supply", address: "supply@rebattery.io" },
];

/** "From alex@rebattery.io ⌄": changes who the email is from, re-signed as that sender. Plain text once it can't change. */
function FromPicker({ from, locked, onPick }: { from: string | null; locked: boolean; onPick: (key: SenderKey) => void }) {
  const current = (from ?? "alex@rebattery.io").toLowerCase();
  const known = FROM.some((f) => f.address === current);
  if (locked) return <span>From {current}.</span>;
  return (
    <label className={w.fromPick}>
      <span>From</span>
      <select value={current} aria-label="Send from" onChange={(e) => { const f = FROM.find((x) => x.address === e.target.value); if (f && f.address !== current) onPick(f.key); }}>
        {!known && <option value={current}>{current}</option>}
        {FROM.map((f) => <option key={f.key} value={f.address}>{f.address}</option>)}
      </select>
    </label>
  );
}

