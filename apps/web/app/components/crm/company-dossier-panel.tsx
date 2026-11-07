"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "../ui/button";
import { MarkdownContent } from "../workspace/markdown-content";
import { formatDayLabel } from "./format-relative-date";

type StaleReason = { date: string | null; reason: string; source_id: string | null };
type SavedSearch = {
  id: string;
  note: string;
  observed_on: string;
  source_kind: string;
  source_ref: string | null;
  source_url: string | null;
};
export type CompanyDossier = {
  company_id: string;
  text: string | null;
  body: string | null;
  frontmatter: Record<string, unknown> | null;
  version: number;
  updated_at: string | null;
  stale_since: string | null;
  stale_reasons: StaleReason[];
  last_verified: string | null;
  saved_searches: SavedSearch[];
};

const cardStyle = { borderColor: "var(--color-border)", background: "var(--color-surface)" };
const muted = { color: "var(--color-text-muted)" };
const TEXTAREA = "w-full rounded-md border px-2 py-1.5 font-mono text-[12px] leading-5";
const inputStyle = { borderColor: "var(--color-border)", background: "var(--color-background)", color: "var(--color-text)" };

const TEMPLATE = [
  "---",
  'company_id: "__COMPANY__"',
  'company: "Company name"',
  "products: []",
  'last_verified: "__TODAY__"',
  "---",
  "## What they buy",
  "",
  "## Notes",
  "",
].join("\n");

function template(companyId: string): string {
  return TEMPLATE
    .replaceAll("__COMPANY__", companyId)
    .replaceAll("__TODAY__", new Date().toISOString().slice(0, 10));
}

/**
 * The dossier panel: the standing buy box as text, when a person last confirmed it, what intake has
 * seen since (the stale flag and its dated reasons), the buyer's own saved searches, and the editor.
 * Nothing writes except saveDossier's route: the editor sends its version and reloads on a conflict.
 */
export function DossierPanel({ companyId, onSaved }: { companyId: string; onSaved?: () => void }) {
  const [dossier, setDossier] = useState<CompanyDossier | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/crm/companies/${encodeURIComponent(companyId)}/buyer-dossier`);
      if (!res.ok) {throw new Error(res.status === 404 ? "Company not found." : `Could not load the dossier (HTTP ${res.status}).`);}
      const data = (await res.json()) as Partial<CompanyDossier>;
      // A partial or unexpected payload must not take the Buyer tab down with it.
      const normalised: CompanyDossier = {
        company_id: String(data.company_id ?? companyId),
        text: typeof data.text === "string" ? data.text : null,
        body: typeof data.body === "string" ? data.body : null,
        frontmatter: data.frontmatter && typeof data.frontmatter === "object" ? data.frontmatter : null,
        version: Number(data.version ?? 0),
        updated_at: data.updated_at ?? null,
        stale_since: data.stale_since ?? null,
        stale_reasons: Array.isArray(data.stale_reasons) ? data.stale_reasons : [],
        last_verified: data.last_verified ?? null,
        saved_searches: Array.isArray(data.saved_searches) ? data.saved_searches : [],
      };
      setDossier(normalised);
      setLoadError(null);
      return normalised;
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not load the dossier.");
      return null;
    }
  }, [companyId]);

  useEffect(() => {
    void load();
  }, [load]);

  function startEditing() {
    setDraft(dossier?.text ?? template(companyId));
    setErrors([]);
    setMessage(null);
    setEditing(true);
  }

  async function save() {
    setBusy(true);
    setErrors([]);
    setMessage(null);
    try {
      const res = await fetch(`/api/crm/companies/${encodeURIComponent(companyId)}/buyer-dossier`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: draft, expected_version: dossier?.version ?? 0 }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        errors?: string[];
        current_text?: string | null;
        current_version?: number;
      };
      if (res.status === 409) {
        setErrors([body.error ?? "The dossier changed while you were editing it."]);
        if (typeof body.current_text === "string") {
          setDraft(body.current_text);
          setDossier((current) => (current
            ? { ...current, text: body.current_text ?? null, version: body.current_version ?? current.version }
            : current));
        }
        return;
      }
      if (!res.ok) {
        setErrors(body.errors?.length ? body.errors : [body.error ?? `Could not save (HTTP ${res.status}).`]);
        return;
      }
      setEditing(false);
      setMessage("Saved.");
      await load();
      onSaved?.();
    } catch (error) {
      setErrors([error instanceof Error ? error.message : "Could not save the dossier."]);
    } finally {
      setBusy(false);
    }
  }

  async function markReviewed() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/crm/companies/${encodeURIComponent(companyId)}/buyer-dossier`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "mark_reviewed" }),
      });
      if (!res.ok) {throw new Error(`HTTP ${res.status}`);}
      setMessage("Marked reviewed.");
      await load();
    } catch {
      setLoadError("Could not mark the dossier reviewed.");
    } finally {
      setBusy(false);
    }
  }

  const stale = dossier?.stale_since ?? null;

  return (
    <section aria-label="Buyer dossier" className="rounded-2xl border p-4" style={cardStyle}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h3 className="text-[14px] font-semibold" style={{ color: "var(--color-text)" }}>Buyer dossier</h3>
        {dossier?.version ? <span className="text-[12px]" style={muted}>v{dossier.version}</span> : null}
        {dossier?.last_verified && <span className="text-[12px]" style={muted}>Last verified {formatDayLabel(dossier.last_verified)}</span>}
        {stale && (
          <span className="rounded-full px-2 py-0.5 text-[11px] font-medium"
            style={{ background: "var(--color-warning-bg, #fff4e5)", color: "var(--color-warning, #8a5300)" }}>
            Needs review since {formatDayLabel(stale)}
          </span>
        )}
        <span className="flex-1" />
        {stale && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void markReviewed()}>Mark reviewed</Button>
        )}
        {editing ? (
          <>
            <Button size="sm" variant="outline" onClick={() => { setEditing(false); setErrors([]); }}>Discard</Button>
            <Button size="sm" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save dossier"}</Button>
          </>
        ) : (
          <Button size="sm" variant="outline" onClick={startEditing} disabled={!dossier}>{dossier?.text ? "Edit dossier" : "Add dossier"}</Button>
        )}
      </div>

      {loadError && <p role="alert" className="text-[13px]" style={{ color: "var(--color-error, #b42318)" }}>{loadError}</p>}
      {message && <p role="status" className="text-[13px]" style={muted}>{message}</p>}
      {errors.length > 0 && (
        <div role="alert" className="mb-2 rounded-md border px-3 py-2 text-[12px]"
          style={{ borderColor: "var(--color-error, #b42318)", color: "var(--color-error, #b42318)" }}>
          <p className="font-medium">Nothing was saved. Fix these first:</p>
          <ul className="mt-1 list-disc pl-5">{errors.map((error) => <li key={error}>{error}</li>)}</ul>
        </div>
      )}

      {stale && dossier?.stale_reasons?.length ? (
        <ul aria-label="Why it needs review" className="mb-3 space-y-1 text-[12px]" style={muted}>
          {dossier.stale_reasons.map((reason) => (
            <li key={`${reason.date}-${reason.source_id}-${reason.reason}`}>
              {reason.date ? `${formatDayLabel(reason.date)}: ` : ""}{reason.reason}
              {reason.source_id ? ` (${reason.source_id})` : ""}
            </li>
          ))}
        </ul>
      ) : null}

      {editing ? (
        <label className="flex flex-col gap-1 text-[12px]" style={muted}>
          Dossier text (Markdown with YAML frontmatter)
          <textarea aria-label="Dossier text" value={draft} onChange={(event) => setDraft(event.target.value)} rows={22}
            className={TEXTAREA} style={inputStyle} spellCheck={false} />
        </label>
      ) : dossier?.body ? (
        <div className="space-y-2 text-[13px]" style={{ color: "var(--color-text)" }}>
          <div className="dossier-markdown"><MarkdownContent content={dossier.body} /></div>
          {dossier.frontmatter && (
            <details className="text-[12px]" style={muted}>
              <summary className="cursor-pointer">Criteria ({Object.keys(dossier.frontmatter).length} keys)</summary>
              <pre className="mt-2 overflow-x-auto rounded-md border p-2 text-[11px]" style={inputStyle}>
                {JSON.stringify(dossier.frontmatter, null, 2)}
              </pre>
            </details>
          )}
        </div>
      ) : (
        <p className="text-[13px]" style={muted}>
          No dossier yet. The dossier holds who they are and what they buy on an ongoing basis; one-off asks with a
          quantity and a date belong in Demand.
        </p>
      )}

      {dossier?.saved_searches?.length ? (
        <div className="mt-4">
          <h4 className="mb-1 text-[13px] font-semibold" style={{ color: "var(--color-text)" }}>Saved searches on rebattery.io</h4>
          <ul className="space-y-1 text-[12px]" style={muted}>
            {dossier.saved_searches.map((search) => (
              <li key={search.id}>
                {formatDayLabel(search.observed_on)}: {search.note}
                {search.source_url && /^https?:\/\//i.test(search.source_url) && (
                  <> · <a href={search.source_url} target="_blank" rel="noreferrer" className="underline" style={{ color: "var(--color-accent)" }}>their search</a></>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
