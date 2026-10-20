"use client";

import { useRef, useState } from "react";
import { shortDate } from "@/lib/bulk-trade-details";

/**
 * The next action of a listing as a cell you edit in place: click, type, Enter or click away to save, Escape to cancel.
 * Clearing the text clears the action. The click never opens the row it sits in.
 */
export function NextActionCell({ value, due, owner, today, onSave }: {
  value: string | null;
  due: string | null;
  owner?: string | null;
  today: string;
  onSave: (text: string | null) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const saving = useRef(false);

  function start(event: React.SyntheticEvent) {
    event.stopPropagation();
    setDraft(value ?? "");
    setError(null);
    setEditing(true);
  }

  async function commit() {
    if (saving.current) return;
    const next = draft.trim() || null;
    if (next === (value ?? null)) { setEditing(false); return; }
    saving.current = true;
    try {
      await onSave(next);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
    } finally {
      saving.current = false;
    }
  }

  if (editing) {
    return (
      <span className="flex min-w-0 flex-col gap-1" onClick={(event) => event.stopPropagation()}>
        <input
          autoFocus
          value={draft}
          maxLength={300}
          aria-label="Next action"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(event) => {
            if (event.key === "Enter") { event.preventDefault(); void commit(); }
            if (event.key === "Escape") { event.preventDefault(); setEditing(false); }
          }}
          className="h-8 w-full min-w-0 border bg-transparent px-2 text-[13px] focus:outline-none focus:ring-2 focus:ring-[var(--bt-text-2)]"
          style={{ borderColor: "var(--bt-border)" }}
        />
        {error && <span className="text-[12px]" style={{ color: "var(--bt-red)" }}>{error}</span>}
      </span>
    );
  }
  const overdue = !!due && due < today;
  return (
    <button type="button" onClick={start} aria-label={value ? `Edit next action: ${value}` : "Add next action"}
      className="group flex w-full min-w-0 flex-col items-start gap-0.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--bt-text-2)]">
      {value
        ? <span className="line-clamp-2 text-[13px] leading-snug group-hover:underline">{value}</span>
        : <span className="text-[13px]" style={{ color: "var(--bt-muted)" }}>Add next step</span>}
      {value && (due || owner) && (
        <span className="text-[12px]" style={{ color: overdue ? "var(--bt-red)" : "var(--bt-muted)" }}>
          {[owner, due ? `${overdue ? "Overdue" : "Due"} ${shortDate(due.slice(0, 10))}` : null].filter(Boolean).join(" · ")}
        </span>
      )}
    </button>
  );
}
