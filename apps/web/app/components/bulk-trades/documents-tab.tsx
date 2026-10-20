"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FileText, Link2, Paperclip, Trash2 } from "lucide-react";
import { DIRECTION_LABEL, DOC_STATES, STATE_LABEL, documentSection, type DocState, type ListingDocument } from "@/lib/bulk-documents";
import type { Registry } from "@/lib/bulk-registry";
import { isImage, shortDate, type NeededFor } from "@/lib/bulk-trade-details";
import { ErrorText, FormField, Modal, buttonClass, buttonStyle, darkButtonClass, darkButtonStyle, request, useForm } from "./trade-ui";
import { useRegistry } from "./use-registry";

const docsUrl = (listingId: string, path = "") => `/api/bulk-listings/${encodeURIComponent(listingId)}/documents${path}`;
const fileUrl = (listingId: string, doc: ListingDocument) => docsUrl(listingId, `/${doc.id}/file?view=1`);

/** Required types with nothing recorded yet: wanted by the listing's kind, shown as needed. */
type Wanted = { type: string; label: string; neededFor: NeededFor };

const extension = (name: string | null) => {
  const dot = name?.lastIndexOf(".") ?? -1;
  return name && dot > 0 ? name.slice(dot + 1, dot + 5).toUpperCase() : "FILE";
};
const host = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } };

function Thumb({ listingId, doc }: { listingId: string; doc: ListingDocument }) {
  const box = "flex h-24 items-center justify-center border-b text-[13px] font-semibold";
  const style = { background: "var(--bt-table-head)", borderColor: "var(--bt-divider)", color: "var(--bt-muted)" };
  if (doc.has_file && doc.file_name && isImage(doc.file_name)) {
    // eslint-disable-next-line @next/next/no-img-element -- private, auth-gated file
    return <img src={fileUrl(listingId, doc)} alt="" loading="lazy" className="h-24 w-full border-b object-cover" style={{ borderColor: "var(--bt-divider)" }} />;
  }
  if (doc.has_file) return <div className={box} style={style}><FileText size={16} aria-hidden="true" className="mr-1.5" />{extension(doc.file_name)}</div>;
  if (doc.url) return <div className={box} style={style}><Link2 size={16} aria-hidden="true" className="mr-1.5" />{host(doc.url)}</div>;
  return <div className={`${box} border-dashed`} style={style}>Not here yet</div>;
}

function DocCard({ listingId, doc, onChange, onRemove, onError }: {
  listingId: string; doc: ListingDocument; onChange: (doc: ListingDocument) => void; onRemove: (id: string) => void; onError: (message: string) => void;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const wanted = documentSection(doc) === "needed";
  const open = doc.has_file ? fileUrl(listingId, doc) : doc.url;
  async function save(patch: Record<string, unknown>) {
    try { onChange((await request<{ document: ListingDocument }>(docsUrl(listingId, `/${doc.id}`), { method: "PATCH", body: JSON.stringify(patch) })).document); }
    catch (err) { onError(err instanceof Error ? err.message : "Could not save."); }
  }
  async function attach(file: File) {
    const body = new FormData();
    body.set("file", file);
    try { onChange((await request<{ document: ListingDocument }>(docsUrl(listingId, `/${doc.id}`), { method: "PATCH", body })).document); }
    catch (err) { onError(err instanceof Error ? err.message : "Could not upload."); }
  }
  async function remove() {
    try { await request(docsUrl(listingId, `/${doc.id}`), { method: "DELETE" }); onRemove(doc.id); }
    catch (err) { onError(err instanceof Error ? err.message : "Could not delete."); }
  }
  return (
    <li className="flex min-w-0 flex-col border" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)", borderStyle: wanted ? "dashed" : "solid" }}>
      <Thumb listingId={listingId} doc={doc} />
      <div className="flex min-w-0 flex-1 flex-col gap-1 p-3">
        <div className="line-clamp-2 text-[13px] font-semibold leading-snug" title={doc.title}>
          {open ? <a href={open} target="_blank" rel="noreferrer" className="hover:underline">{doc.title}</a> : doc.title}
        </div>
        <div className="text-[12px]" style={{ color: "var(--bt-muted)" }}>
          {[doc.doc_type, doc.source_label, doc.source_date ? shortDate(doc.source_date) : shortDate(doc.created_at.slice(0, 10))].filter(Boolean).join(" · ")}
        </div>
        {doc.note && <div className="line-clamp-2 text-[12px]" style={{ color: "var(--bt-text-2)" }} title={doc.note}>{doc.note}</div>}
        <div className="mt-auto flex flex-wrap items-center gap-2 pt-2">
          <select aria-label={`State of ${doc.title}`} value={doc.state} onChange={(event) => void save({ state: event.target.value })}
            className="h-7 border px-1 text-[12px]" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
            {DOC_STATES.map((state) => <option key={state} value={state}>{STATE_LABEL[state as DocState]}</option>)}
          </select>
          {doc.direction !== "received" && <span className="text-[12px]" style={{ color: "var(--bt-muted)" }}>{DIRECTION_LABEL[doc.direction]}</span>}
          <span className="flex-1" />
          {wanted && (
            <>
              <input ref={picker} type="file" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void attach(file); event.target.value = ""; }} />
              <button type="button" className="inline-flex items-center gap-1 text-[12px] font-medium hover:underline" onClick={() => picker.current?.click()}>
                <Paperclip size={12} aria-hidden="true" /> Attach file
              </button>
            </>
          )}
          <button type="button" aria-label={`Delete ${doc.title}`} className="p-1" style={{ color: "var(--bt-muted)" }} onClick={() => void remove()}><Trash2 size={13} aria-hidden="true" /></button>
        </div>
      </div>
    </li>
  );
}

function WantedCard({ listingId, item, onAdded, onError }: { listingId: string; item: Wanted; onAdded: (doc: ListingDocument) => void; onError: (message: string) => void }) {
  const picker = useRef<HTMLInputElement>(null);
  async function create(file: File | null) {
    try {
      if (file) {
        const body = new FormData();
        body.set("file", file); body.set("title", item.label); body.set("doc_type", item.type);
        onAdded((await request<{ document: ListingDocument }>(docsUrl(listingId), { method: "POST", body })).document);
      } else {
        onAdded((await request<{ document: ListingDocument }>(docsUrl(listingId), { method: "POST", body: JSON.stringify({ title: item.label, doc_type: item.type, state: "needed" }) })).document);
      }
    } catch (err) { onError(err instanceof Error ? err.message : "Could not save."); }
  }
  return (
    <li className="flex min-w-0 flex-col border border-dashed" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border-strong)" }}>
      <div className="flex h-24 items-center justify-center border-b border-dashed text-[13px]" style={{ background: "var(--bt-table-head)", borderColor: "var(--bt-divider)", color: "var(--bt-muted)" }}>Not here yet</div>
      <div className="flex flex-1 flex-col gap-1 p-3">
        <div className="text-[13px] font-semibold leading-snug">{item.label}</div>
        <div className="text-[12px]" style={{ color: "var(--bt-muted)" }}>{item.type} · needed for {item.neededFor}</div>
        <div className="mt-auto flex items-center gap-3 pt-2">
          <input ref={picker} type="file" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void create(file); event.target.value = ""; }} />
          <button type="button" className="inline-flex items-center gap-1 text-[12px] font-medium hover:underline" onClick={() => picker.current?.click()}><Paperclip size={12} aria-hidden="true" /> Attach file</button>
          <button type="button" className="text-[12px] hover:underline" style={{ color: "var(--bt-muted)" }} onClick={() => void create(null)}>Mark as requested</button>
        </div>
      </div>
    </li>
  );
}

type Mode = "upload" | "link" | "request";
const MODE_TITLE: Record<Mode, string> = { upload: "Upload a file", link: "Add a link", request: "Ask for a document" };

function AddDialog({ listingId, mode, registry, onClose, onAdded }: { listingId: string; mode: Mode; registry: Registry; onClose: () => void; onAdded: (doc: ListingDocument) => void }) {
  const picker = useRef<HTMLInputElement>(null);
  const form = useForm({ title: "", doc_type: "Other", url: "", note: "", direction: "received" }, async (draft) => {
    if (mode === "upload") {
      const file = picker.current?.files?.[0];
      if (!file) throw new Error("Choose a file.");
      const body = new FormData();
      body.set("file", file); body.set("title", draft.title.trim() || file.name); body.set("doc_type", draft.doc_type); body.set("direction", draft.direction);
      if (draft.note.trim()) body.set("note", draft.note.trim());
      onAdded((await request<{ document: ListingDocument }>(docsUrl(listingId), { method: "POST", body })).document);
      return;
    }
    if (!draft.title.trim()) throw new Error("Give it a title.");
    onAdded((await request<{ document: ListingDocument }>(docsUrl(listingId), { method: "POST", body: JSON.stringify({
      title: draft.title.trim(), doc_type: draft.doc_type, direction: draft.direction, note: draft.note.trim() || null,
      ...(mode === "link" ? { url: draft.url.trim(), state: draft.direction === "received" ? "received" : "sent" } : { state: "needed" }),
    }) })).document);
  });
  return (
    <Modal title={MODE_TITLE[mode]} onClose={onClose} onSubmit={form.submit}
      footer={<button type="submit" disabled={form.saving} className={darkButtonClass} style={darkButtonStyle}>{form.saving ? "Saving" : "Save"}</button>}>
      {mode === "upload" && <FormField label="File (up to 25 MB)"><input ref={picker} type="file" required className="text-sm" /></FormField>}
      <FormField label="Title">{form.input("title", { autoFocus: mode !== "upload", placeholder: mode === "request" ? "Toyota pack datasheet" : "" })}</FormField>
      {mode === "link" && <FormField label="Link">{form.input("url", { type: "url", required: true, placeholder: "https://" })}</FormField>}
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Type">{form.select("doc_type", registry.documentTypes)}</FormField>
        {mode !== "request" && <FormField label="From">{form.select("direction", ["received", "sent", "prepared"], DIRECTION_LABEL)}</FormField>}
      </div>
      <FormField label="Note">{form.input("note", { placeholder: "Optional" })}</FormField>
      <ErrorText error={form.error} />
    </Modal>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="font-mono text-[11px] uppercase tracking-[0.06em]" style={{ color: "var(--bt-muted)" }}>{title} · {count}</h3>
      <ul className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>{children}</ul>
    </section>
  );
}

/**
 * Documents of a bulk listing: what is wanted, what came in, and what we made or sent, as cards.
 * Required document types for the listing's kind show as wanted until something is recorded for them.
 */
export function DocumentsTab({ listingId, wantsRequired }: { listingId: string; wantsRequired: boolean }) {
  const registry = useRegistry();
  const [docs, setDocs] = useState<ListingDocument[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<Mode | null>(null);
  const load = useCallback(async () => {
    try { setDocs((await request<{ documents: ListingDocument[] }>(docsUrl(listingId))).documents); setError(null); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not load documents."); }
  }, [listingId]);
  useEffect(() => { void load(); }, [load]);
  if (!registry) return null;
  if (!docs) return <p className="text-[13px]" style={{ color: "var(--bt-muted)" }}>{error ?? "Loading…"}</p>;

  const upsert = (doc: ListingDocument) => setDocs((current) => [doc, ...(current ?? []).filter((item) => item.id !== doc.id)].sort((a, b) => b.created_at.localeCompare(a.created_at)));
  const remove = (id: string) => setDocs((current) => (current ?? []).filter((item) => item.id !== id));
  const have = new Set(docs.filter((doc) => documentSection(doc) !== "needed").map((doc) => doc.doc_type));
  const asked = new Set(docs.filter((doc) => documentSection(doc) === "needed").map((doc) => doc.doc_type));
  const required: Wanted[] = wantsRequired
    ? registry.requiredFiles.filter((file) => !have.has(file.type) && !asked.has(file.type)).map((file) => ({ type: file.type, label: file.label, neededFor: file.neededFor }))
    : [];
  const sections = {
    needed: docs.filter((doc) => documentSection(doc) === "needed"),
    received: docs.filter((doc) => documentSection(doc) === "received"),
    ours: docs.filter((doc) => documentSection(doc) === "ours"),
  };
  const card = (doc: ListingDocument) => <DocCard key={doc.id} listingId={listingId} doc={doc} onChange={upsert} onRemove={remove} onError={setError} />;
  return (
    <div className="flex w-full flex-col gap-6" data-documents>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={`${buttonClass} !h-8`} style={buttonStyle} onClick={() => setAdding("upload")}>Upload</button>
        <button type="button" className={`${buttonClass} !h-8`} style={buttonStyle} onClick={() => setAdding("link")}>Add link</button>
        <button type="button" className={`${buttonClass} !h-8`} style={buttonStyle} onClick={() => setAdding("request")}>Ask for a document</button>
        <ErrorText error={error} />
      </div>
      {sections.needed.length + required.length > 0 && (
        <Section title="Needed" count={sections.needed.length + required.length}>
          {sections.needed.map(card)}
          {required.map((item) => <WantedCard key={item.type} listingId={listingId} item={item} onAdded={upsert} onError={setError} />)}
        </Section>
      )}
      {sections.received.length > 0 && <Section title="Received" count={sections.received.length}>{sections.received.map(card)}</Section>}
      {sections.ours.length > 0 && <Section title="Ours" count={sections.ours.length}>{sections.ours.map(card)}</Section>}
      {docs.length + required.length === 0 && <p className="text-[13px]" style={{ color: "var(--bt-muted)" }}>No documents yet. Upload a file, add a link, or ask for one.</p>}
      {adding && <AddDialog listingId={listingId} mode={adding} registry={registry} onClose={() => setAdding(null)} onAdded={(doc) => { upsert(doc); setAdding(null); }} />}
    </div>
  );
}
