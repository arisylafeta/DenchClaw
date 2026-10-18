"use client";

import { useState } from "react";
import type { CompanyContextNote } from "@/lib/crm-postgres/company-context";

const muted = { color: "var(--bt-muted, var(--color-text-muted))" };

export function CompanyContext({ notes, filterable = false }: { notes: CompanyContextNote[]; filterable?: boolean }) {
  const [category, setCategory] = useState("all");
  const sorted = [...(notes ?? [])].sort((a, b) =>
    b.observed_on.localeCompare(a.observed_on) || b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id));
  const categories = [...new Set(sorted.map((note) => note.category))].sort();
  const visible = category === "all" || !categories.includes(category as CompanyContextNote["category"])
    ? sorted : sorted.filter((note) => note.category === category);
  if (!sorted.length && !filterable) return null;
  return (
    <section aria-label="Company context notes">
      <h3 className="text-[11px] uppercase tracking-wider" style={muted}>Company context</h3>
      {filterable && categories.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Filter context by category">
          {["all", ...categories].map((value) => (
            <button key={value} type="button" aria-pressed={category === value}
              onClick={() => setCategory(value)}
              className="min-h-9 rounded border px-3 text-[11px] uppercase focus-visible:outline focus-visible:outline-2"
              style={{ ...muted, borderColor: "var(--color-border)", background: category === value ? "var(--color-surface-hover)" : "transparent" }}>
              {value.replaceAll("_", " ")}
            </button>
          ))}
        </div>
      )}
      <ul className="mt-3 space-y-3">
        {visible.map((note) => (
          <li key={note.id}>
            <span className="mb-1 inline-block rounded border px-1.5 py-0.5 text-[11px] uppercase"
              style={{ ...muted, borderColor: "var(--color-border)" }}>{note.category.replaceAll("_", " ")}</span>
            <p className="whitespace-pre-wrap text-[13px]">{note.note}</p>
            <p className="mt-1 text-[13px]" style={muted}>
              {[note.source_kind, note.observed_on].filter(Boolean).join(" · ")}
              {note.source_url && /^https?:\/\//i.test(note.source_url) && (
                <> · <a className="underline" href={note.source_url} target="_blank" rel="noreferrer">Source</a></>
              )}
            </p>
          </li>
        ))}
      </ul>
      {!sorted.length && <p className="mt-3 text-[13px]" style={muted}>No context notes yet.</p>}
    </section>
  );
}
