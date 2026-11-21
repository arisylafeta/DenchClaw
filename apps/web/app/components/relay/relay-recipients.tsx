"use client";

import { useEffect, useId, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import type { Contact } from "@/lib/relay-contacts";
import { addressList, isAddress } from "@/lib/relay-workspace-core";
import { api, cx } from "./relay-ui";
import w from "./relay-workspace.module.css";

/** Names Relay has seen for addresses this visit, so a chip can say "Fabio Papa" rather than the address. */
const known = new Map<string, string>();

/**
 * To, Cc or Bcc as chips, like Gmail: type a name, company or address and pick from Alex's contacts (CRM and mail he has
 * sent and received), or finish an address with Enter, comma or space. Each chip has its own ×; Backspace in an empty
 * box takes the last one off. A chip that isn't an email address shows red and Save refuses it.
 */
export function RecipientInput({ label, value, onChange, autoFocus }: {
  label: string; value: string[]; onChange: (next: string[]) => void; autoFocus?: boolean;
}) {
  const [text, setText] = useState("");
  const [found, setFound] = useState<Contact[]>([]);
  const [at, setAt] = useState(0);
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();

  // Search as he types, a beat after the last key, and only show the newest answer.
  useEffect(() => {
    const q = text.trim();
    if (q.length < 2) { setFound([]); return; }
    let live = true;
    const t = setTimeout(() => {
      api<{ contacts: Contact[] }>(`/api/relay/contacts?q=${encodeURIComponent(q)}`)
        .then((r) => {
          if (!live) return;
          for (const c of r.contacts) if (c.name) known.set(c.email, c.name);
          setFound(r.contacts.filter((c) => !value.includes(c.email)));
          setAt(0);
          setOpen(true);
        })
        .catch(() => { if (live) setFound([]); });
    }, 140);
    return () => { live = false; clearTimeout(t); };
  }, [text, value]);

  const add = (emails: string[]) => {
    const next = [...value];
    for (const e of emails) if (e && !next.includes(e)) next.push(e);
    onChange(next);
    setText("");
    setFound([]);
    setOpen(false);
  };
  const remove = (email: string) => { onChange(value.filter((e) => e !== email)); input.current?.focus(); };
  const pick = (c: Contact) => add([c.email]);

  const keys = (e: KeyboardEvent<HTMLInputElement>) => {
    const menu = open && found.length > 0;
    if (menu && e.key === "ArrowDown") { e.preventDefault(); setAt((a) => (a + 1) % found.length); return; }
    if (menu && e.key === "ArrowUp") { e.preventDefault(); setAt((a) => (a - 1 + found.length) % found.length); return; }
    if (menu && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setOpen(false); return; }
    if (e.key === "Enter" || e.key === "Tab" || e.key === "," || e.key === ";" || (e.key === " " && text.includes("@"))) {
      if (menu && (e.key === "Enter" || e.key === "Tab")) { e.preventDefault(); pick(found[at]); return; }
      if (text.trim()) { e.preventDefault(); add(addressList(text)); }
      return;
    }
    if (e.key === "Backspace" && !text && value.length) { e.preventDefault(); onChange(value.slice(0, -1)); }
  };
  const paste = (e: ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData("text");
    if (/[\s,;]/.test(pasted.trim()) && pasted.includes("@")) { e.preventDefault(); add(addressList(pasted)); }
  };

  return (
    <div className={w.rcpt} onClick={() => input.current?.focus()}>
      <span className={w.rcptLabel} id={`${listId}-label`}>{label}</span>
      <ul className={w.rchips} aria-labelledby={`${listId}-label`}>
        {value.map((email) => {
          const name = known.get(email);
          const bad = !isAddress(email);
          return (
            <li key={email} className={cx(w.rchip, bad && w.rchipBad)} title={bad ? "Not an email address" : email}>
              <span>{name ?? email}</span>
              <button type="button" aria-label={`Remove ${name ?? email}`} onClick={(e) => { e.stopPropagation(); remove(email); }}><X size={12} aria-hidden /></button>
            </li>
          );
        })}
        <li className={w.rchipInput}>
          <input ref={input} value={text} autoFocus={autoFocus} aria-label={label} role="combobox" aria-expanded={open && found.length > 0}
            aria-controls={listId} aria-autocomplete="list" aria-activedescendant={open && found.length ? `${listId}-${at}` : undefined}
            autoComplete="off" spellCheck={false} placeholder={value.length ? "" : "Name or email"}
            onChange={(e) => { setText(e.target.value); setOpen(true); }} onKeyDown={keys} onPaste={paste}
            onBlur={() => { setTimeout(() => setOpen(false), 120); if (text.trim().includes("@")) add(addressList(text)); }} />
        </li>
      </ul>
      {open && found.length > 0 && (
        <ul className={w.suggest} id={listId} role="listbox">
          {found.map((c, k) => (
            <li key={c.email} id={`${listId}-${k}`} role="option" aria-selected={k === at} className={cx(k === at && w.suggestOn)}
              onMouseDown={(e) => { e.preventDefault(); pick(c); }} onMouseEnter={() => setAt(k)}>
              <b>{c.name ?? c.email}</b>
              <span>{c.name ? c.email : ""}{c.company ? `${c.name ? " · " : ""}${c.company}` : ""}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
