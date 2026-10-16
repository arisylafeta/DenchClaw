import type { CompanyContextNote } from "@/lib/crm-postgres/company-context";

export function CompanyContext({ notes }: { notes: CompanyContextNote[] }) {
  if (!notes?.length) return null;
  return (
    <section aria-label="Company context notes">
      <h3
        className="text-[11px] uppercase tracking-wider"
        style={{ color: "var(--bt-muted)" }}
      >
        Company context
      </h3>
      <ul className="mt-3 space-y-3">
        {notes.map((note) => (
          <li key={note.id}>
            <p className="whitespace-pre-wrap text-[13px]">{note.note}</p>
            <p
              className="mt-1 text-[13px]"
              style={{ color: "var(--bt-muted)" }}
            >
              {[note.source_kind, note.observed_on].filter(Boolean).join(" · ")}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
