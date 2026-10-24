"use client";

import { useCallback, useEffect, useState } from "react";
import { FileText, Link2, Trash2 } from "lucide-react";
import { DIRECTION_LABEL, DOC_STATES, STATE_LABEL, documentSection, type DocState, type ListingDocument } from "@/lib/bulk-documents";
import { isImage, shortDate } from "@/lib/bulk-trade-details";
import { ErrorText, request } from "./trade-ui";

import { BusyRegion, Sh } from "./bt-shimmer";

const docsUrl = (listingId: string, path = "") => `/api/bulk-listings/${encodeURIComponent(listingId)}/documents${path}`;
const fileUrl = (listingId: string, doc: ListingDocument) => docsUrl(listingId, `/${doc.id}/file?view=1`);

const extension = (name: string | null) => {
  const dot = name?.lastIndexOf(".") ?? -1;
  return name && dot > 0 ? name.slice(dot + 1, dot + 5).toUpperCase() : "FILE";
};
const host = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } };

function Thumb({ listingId, doc, loading = false }: { listingId: string; doc: ListingDocument; loading?: boolean }) {
  const box = "flex h-24 items-center justify-center border-b text-[13px] font-semibold";
  const style = { background: "var(--bt-table-head)", borderColor: "var(--bt-divider)", color: "var(--bt-muted)" };
  if (loading) return <div className={box} style={style}><FileText size={16} aria-hidden="true" className="mr-1.5" /><Sh on chars={5} /></div>;
  if (doc.has_file && doc.file_name && isImage(doc.file_name)) {
    // eslint-disable-next-line @next/next/no-img-element -- private, auth-gated file
    return <img src={fileUrl(listingId, doc)} alt="" loading="lazy" className="h-24 w-full border-b object-cover" style={{ borderColor: "var(--bt-divider)" }} />;
  }
  if (doc.has_file) return <div className={box} style={style}><FileText size={16} aria-hidden="true" className="mr-1.5" />{extension(doc.file_name)}</div>;
  if (doc.url) return <div className={box} style={style}><Link2 size={16} aria-hidden="true" className="mr-1.5" />{host(doc.url)}</div>;
  return <div className={`${box} border-dashed`} style={style}>Not here yet</div>;
}

function DocCard({ listingId, doc, onChange, onRemove, onError, loading = false }: {
  listingId: string; doc: ListingDocument; loading?: boolean; onChange: (doc: ListingDocument) => void; onRemove: (id: string) => void; onError: (message: string) => void;
}) {
  const open = doc.has_file ? fileUrl(listingId, doc) : doc.url;
  async function save(patch: Record<string, unknown>) {
    try { onChange((await request<{ document: ListingDocument }>(docsUrl(listingId, `/${doc.id}`), { method: "PATCH", body: JSON.stringify(patch) })).document); }
    catch (err) { onError(err instanceof Error ? err.message : "Could not save."); }
  }
  async function remove() {
    try { await request(docsUrl(listingId, `/${doc.id}`), { method: "DELETE" }); onRemove(doc.id); }
    catch (err) { onError(err instanceof Error ? err.message : "Could not delete."); }
  }
  return (
    <li className="flex min-w-0 flex-col border" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
      <Thumb listingId={listingId} doc={doc} loading={loading} />
      <div className="flex min-w-0 flex-1 flex-col gap-1 p-3">
        <div className="line-clamp-2 text-[13px] font-semibold leading-snug" title={doc.title}>
          <Sh on={loading} chars={20}>{open ? <a href={open} target="_blank" rel="noreferrer" className="hover:underline">{doc.title}</a> : doc.title}</Sh>
        </div>
        <div className="text-[12px]" style={{ color: "var(--bt-muted)" }}>
          <Sh on={loading} chars={25}>{[doc.doc_type, doc.source_label, doc.source_date ? shortDate(doc.source_date) : shortDate(doc.created_at.slice(0, 10))].filter(Boolean).join(" · ")}</Sh>
        </div>
        {doc.note && <div className="line-clamp-2 text-[12px]" style={{ color: "var(--bt-text-2)" }} title={doc.note}>{doc.note}</div>}
        <div className="mt-auto flex flex-wrap items-center gap-2 pt-2">
          {loading ? <span className="flex h-7 items-center border px-1 text-[12px]" style={{ borderColor: "var(--bt-border)" }}><Sh on chars={8} /></span> : <select aria-label={`State of ${doc.title}`} value={doc.state} onChange={(event) => void save({ state: event.target.value })}
            className="h-7 border px-1 text-[12px]" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
            {DOC_STATES.map((state) => <option key={state} value={state}>{STATE_LABEL[state as DocState]}</option>)}
          </select>}
          {doc.direction !== "received" && <span className="text-[12px]" style={{ color: "var(--bt-muted)" }}><Sh on={loading} chars={7}>{DIRECTION_LABEL[doc.direction]}</Sh></span>}
          <span className="flex-1" />
          <button disabled={loading} type="button" aria-label={`Delete ${doc.title}`} className="p-1" style={{ color: "var(--bt-muted)" }} onClick={() => void remove()}><Trash2 size={13} aria-hidden="true" /></button>
        </div>
      </div>
    </li>
  );
}

function Section({ title, count, children, loading = false }: { title: string; count: number; loading?: boolean; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="font-mono text-[11px] uppercase tracking-[0.06em]" style={{ color: "var(--bt-muted)" }}>{title} · <Sh on={loading} chars={1}>{count}</Sh></h3>
      <ul className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>{children}</ul>
    </section>
  );
}

/**
 * Documents of a bulk listing: what came in, and what we made or sent, as cards. Nothing is listed as "needed":
 * a document is only shown once there is something to show.
 */
export function DocumentsTab({ listingId }: { listingId: string }) {
  const [docs, setDocs] = useState<ListingDocument[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setDocs((await request<{ documents: ListingDocument[] }>(docsUrl(listingId))).documents); setError(null); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not load documents."); }
  }, [listingId]);
  useEffect(() => { void load(); }, [load]);
  if (!docs) return (
    <BusyRegion busy={!error} label="Loading documents" className="flex w-full flex-col gap-6">
      <ErrorText error={error} />
      {!error && (["Received", "Ours"] as const).map((title, i) => (
        <Section key={title} title={title} count={1} loading>
          <DocCard listingId={listingId} loading doc={{ id: `loading-${i}`, title: "", doc_type: "", state: "received", direction: i === 1 ? "prepared" : "received", created_at: "", has_file: false } as ListingDocument} onChange={() => {}} onRemove={() => {}} onError={setError} />
        </Section>
      ))}
    </BusyRegion>
  );

  const upsert = (doc: ListingDocument) => setDocs((current) => [doc, ...(current ?? []).filter((item) => item.id !== doc.id)].sort((a, b) => b.created_at.localeCompare(a.created_at)));
  const remove = (id: string) => setDocs((current) => (current ?? []).filter((item) => item.id !== id));
  const sections = {
    received: docs.filter((doc) => documentSection(doc) === "received"),
    ours: docs.filter((doc) => documentSection(doc) === "ours"),
  };
  const card = (doc: ListingDocument) => <DocCard key={doc.id} listingId={listingId} doc={doc} onChange={upsert} onRemove={remove} onError={setError} />;
  return (
    <div className="flex w-full flex-col gap-6" data-documents>
      <ErrorText error={error} />
      {sections.received.length > 0 && <Section title="Received" count={sections.received.length}>{sections.received.map(card)}</Section>}
      {sections.ours.length > 0 && <Section title="Ours" count={sections.ours.length}>{sections.ours.map(card)}</Section>}
      {docs.length === 0 && <p className="text-[13px]" style={{ color: "var(--bt-muted)" }}>No documents yet.</p>}
    </div>
  );
}
