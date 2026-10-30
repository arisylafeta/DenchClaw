"use client";

import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, ExternalLinkIcon, MaximizeIcon, PencilIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { Badge } from "@/app/components/platform-admin/ui/badge";
import { Button } from "@/app/components/platform-admin/ui/button";
import { Input } from "@/app/components/platform-admin/ui/input";
import { Textarea } from "@/app/components/platform-admin/ui/textarea";
import { getLabelReviewPage, recordLabelGroupDecision } from "./actions";
import { groupEntries, type LabelDecision, type LabelGroup, type LabelReviewEntry, type LabelReviewPage } from "./contract";

type Filter = "todo" | "mismatch" | "done" | "all";

const MATCH_TEXT: Record<LabelReviewEntry["match"], string> = {
  match: "Label matches stored value",
  mismatch: "Label differs from stored value",
  no_energy: "No energy printed in the reading",
  no_stored: "No stored value yet",
};

const fmt = (n: number | null, unit: string) => (n === null ? "none" : `${n} ${unit}`);
const rowName = (e: LabelReviewEntry) => `${e.make ?? ""} ${e.model ?? ""}${e.donorYear ? ` (${e.donorYear})` : ""}`.trim();

/** The label energy most readings of the group agree on, used to prefill a correction. */
function commonLabelKwh(group: LabelGroup): number | null {
  const counts = new Map<number, number>();
  for (const e of group.entries) if (!e.decision && e.parsed.kwh !== null) counts.set(e.parsed.kwh, (counts.get(e.parsed.kwh) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

export function LabelReviewClient({ initialPage }: { initialPage: LabelReviewPage }) {
  const [page, setPage] = useState(initialPage);
  const [filter, setFilter] = useState<Filter>(initialPage.mismatches > 0 ? "mismatch" : "todo");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selectedReading, setSelectedReading] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [correcting, setCorrecting] = useState(false);
  const [kwh, setKwh] = useState("");
  const [shown, setShown] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const [pending, startTransition] = useTransition();

  const groups = useMemo(() => groupEntries(page.entries), [page.entries]);
  const visible = useMemo(
    () => groups.filter((g) => (filter === "all" ? true : filter === "done" ? g.pending === 0 : filter === "mismatch" ? g.mismatches > 0 : g.pending > 0)),
    [groups, filter],
  );
  const group = visible.find((g) => g.key === selectedKey) ?? visible[0] ?? null;
  const current = group
    ? (group.entries.find((e) => e.observationId === selectedReading)
      ?? group.entries.find((e) => !e.decision && e.match === "mismatch")
      ?? group.entries.find((e) => !e.decision)
      ?? group.entries[0])
    : null;
  const pendingIds = useMemo(() => group?.entries.filter((e) => !e.decision).map((e) => e.observationId) ?? [], [group]);
  const photos = useMemo(() => (current ? [current.photoUrl, ...current.otherPhotos] : []), [current]);
  const photo = shown ?? current?.photoUrl ?? null;
  const photoIndex = Math.max(0, photos.indexOf(photo ?? ""));
  const step = useCallback((by: number) => {
    if (photos.length < 2) return;
    setShown(photos[(photoIndex + by + photos.length) % photos.length]);
    setZoomed(false);
  }, [photos, photoIndex]);

  useEffect(() => { setNote(""); setCorrecting(false); setKwh(""); setSelectedReading(null); setShown(null); setLightbox(false); setZoomed(false); }, [group?.key]);
  useEffect(() => { setShown(null); setZoomed(false); }, [current?.observationId]);

  const move = useCallback((by: number) => {
    if (!visible.length) return;
    const at = Math.max(0, visible.findIndex((g) => g.key === group?.key));
    setSelectedKey(visible[Math.min(visible.length - 1, Math.max(0, at + by))].key);
  }, [visible, group?.key]);

  const decide = useCallback((decision: LabelDecision) => {
    if (!group || pending || pendingIds.length === 0) return;
    if (decision === "correct" && !correcting) { setCorrecting(true); setKwh(String(commonLabelKwh(group) ?? "")); return; }
    startTransition(async () => {
      const result = await recordLabelGroupDecision({ observationIds: pendingIds, decision, note, correctedKwh: decision === "correct" ? Number(kwh.replace(",", ".")) : null });
      if (!result.ok) { toast.error(result.error); if (result.done > 0) setPage(await getLabelReviewPage()); return; }
      toast.success(`${decision === "approve" ? "Approved" : decision === "reject" ? "Rejected" : "Corrected"} ${result.done} ${result.done === 1 ? "reading" : "readings"}`);
      const next = visible[visible.findIndex((g) => g.key === group.key) + 1];
      setPage(await getLabelReviewPage());
      if (next) setSelectedKey(next.key);
    });
  }, [group, pending, pendingIds, correcting, note, kwh, visible]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (lightbox) {
        if (event.key === "Escape") setLightbox(false);
        else if (event.key === "ArrowRight") step(1);
        else if (event.key === "ArrowLeft") step(-1);
        return;
      }
      if (event.key === "ArrowRight") step(1);
      else if (event.key === "ArrowLeft") step(-1);
      else if (event.key === "f") setLightbox(true);
      else if (event.key === "j") move(1);
      else if (event.key === "k") move(-1);
      else if (event.key === "a") decide("approve");
      else if (event.key === "r") decide("reject");
      else if (event.key === "c") decide("correct");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [move, decide, step, lightbox]);

  const donePct = page.total ? Math.round((page.decided / page.total) * 100) : 0;
  const decidedHere = group ? group.entries.length - group.pending : 0;

  return (
    <div className="flex h-screen flex-col bg-[var(--color-main-bg)] text-[var(--color-text)]">
      <header className="flex flex-wrap items-center gap-3 border-b border-[var(--color-border)] px-4 py-3">
        <h1 className="text-sm font-semibold">Label review</h1>
        <span className="text-xs text-[var(--color-text-muted)]">{groups.length} part codes · {page.decided} of {page.total} readings checked · {page.mismatches} differ from the stored value</span>
        <div className="h-1 w-32 overflow-hidden rounded bg-[var(--color-border)]" aria-hidden><div className="h-full bg-[var(--color-accent)]" style={{ width: `${donePct}%` }} /></div>
        <div className="ml-auto flex gap-1" role="tablist" aria-label="Filter">
          {([["mismatch", "Differs"], ["todo", "To check"], ["done", "Checked"], ["all", "All"]] as const).map(([key, label]) => (
            <Button key={key} size="xs" variant={filter === key ? "default" : "outline"} onClick={() => setFilter(key)} aria-pressed={filter === key}>{label}</Button>
          ))}
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(0,12rem)_minmax(0,1fr)] md:grid-cols-[17rem_minmax(0,1fr)] md:grid-rows-1">
        <nav className="min-h-0 overflow-auto border-b border-[var(--color-border)] md:border-b-0 md:border-r" aria-label="Part codes">
          {visible.length === 0 && <p className="p-4 text-xs text-[var(--color-text-muted)]">Nothing here.</p>}
          {visible.map((g) => (
            <button key={g.key} type="button" onClick={() => setSelectedKey(g.key)} aria-current={g.key === group?.key}
              className={`block w-full border-b border-[var(--color-border)] px-3 py-2 text-left text-xs hover:bg-[var(--color-surface-hover)] focus-visible:outline focus-visible:outline-2 ${g.key === group?.key ? "bg-[var(--color-surface-hover)]" : ""}`}>
              <span className="block truncate font-medium">{g.title}</span>
              <span className="block truncate text-[var(--color-text-muted)]">{g.subtitle}</span>
              <span className="mt-0.5 flex items-center gap-2">
                {g.mismatches > 0 ? <Badge variant="destructive">{g.mismatches} differ</Badge> : g.pending === 0 ? <Badge variant="secondary">checked</Badge> : <span className="text-[var(--color-text-muted)]">{g.pending} to check</span>}
              </span>
            </button>
          ))}
        </nav>

        {group && current ? (
          <div className="flex min-h-0 min-w-0 flex-col">
            <section className="max-h-[50%] min-w-0 shrink-0 overflow-auto border-b border-[var(--color-border)] p-4" aria-label="Output">
              <h2 className="text-sm font-semibold">{group.title}</h2>
              <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">{group.subtitle}{decidedHere ? ` · ${decidedHere} already checked` : ""}</p>

              <table className="mt-3 w-full text-xs" aria-label="Readings in this group">
                <thead><tr className="text-left text-[var(--color-text-muted)]"><th className="py-1 font-normal">Row</th><th className="font-normal">Photo</th><th className="font-normal">Label</th><th className="font-normal">Stored</th><th className="font-normal"> </th></tr></thead>
                <tbody>
                  {group.entries.map((e) => (
                    <tr key={e.observationId} onClick={() => setSelectedReading(e.observationId)} aria-selected={e.observationId === current.observationId}
                      className={`cursor-pointer border-t border-[var(--color-border)] hover:bg-[var(--color-surface-hover)] ${e.observationId === current.observationId ? "bg-[var(--color-surface-hover)]" : ""}`}>
                      <td className="py-1">{rowName(e)}</td>
                      <td>{e.photoNumber ?? "?"}</td>
                      <td className={e.match === "mismatch" ? "text-[var(--color-error)]" : ""}>{fmt(e.parsed.kwh, "kWh")}{e.parsed.voltage !== null ? ` · ${e.parsed.voltage} V` : ""}</td>
                      <td>{fmt(e.stored.packKwh, "kWh")}{e.stored.packKwhAuthority ? ` · ${e.stored.packKwhAuthority}` : ""}</td>
                      <td>{e.decision ? <Badge variant="secondary">{e.decision.decision}</Badge> : e.match === "mismatch" ? <Badge variant="destructive">differs</Badge> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <p className={`mt-3 rounded-md px-2 py-1 text-xs ${current.match === "mismatch" ? "bg-[var(--color-error)]/10 text-[var(--color-error)]" : "bg-[var(--color-surface-hover)]"}`}>{MATCH_TEXT[current.match]} · read by {current.actor ?? "unknown"}</p>
              <h3 className="mt-3 text-xs font-medium">Transcription of the selected reading</h3>
              <pre className="mt-1 whitespace-pre-wrap break-words rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-2 text-xs">{current.text}</pre>

              {pendingIds.length === 0 ? (
                <p className="mt-4 text-xs">Everything in this group is checked.{current.decision ? ` Last: ${current.decision.decision} by ${current.decision.by}${current.decision.note ? ` — ${current.decision.note}` : ""}` : ""}</p>
              ) : (
                <div className="mt-4 space-y-2">
                  {correcting && (
                    <label className="block text-xs">Pack energy on the label (kWh), set on every row in this group
                      <Input inputMode="decimal" value={kwh} onChange={(ev) => setKwh(ev.target.value)} className="mt-1 w-32" aria-label="Corrected pack energy in kWh" />
                    </label>
                  )}
                  <Textarea value={note} onChange={(ev) => setNote(ev.target.value)} placeholder="Notes (required to reject)" rows={2} aria-label="Notes" />
                  <div className="flex flex-wrap gap-2">
                    <Button onClick={() => decide("approve")} disabled={pending}><CheckIcon /> Approve {pendingIds.length} <kbd className="text-[10px] opacity-70">A</kbd></Button>
                    <Button variant="destructive" onClick={() => decide("reject")} disabled={pending}><XIcon /> Reject {pendingIds.length} <kbd className="text-[10px] opacity-70">R</kbd></Button>
                    <Button variant="outline" onClick={() => decide("correct")} disabled={pending}><PencilIcon /> {correcting ? "Save correction" : "Correct"} <kbd className="text-[10px] opacity-70">C</kbd></Button>
                  </div>
                  <p className="text-[11px] text-[var(--color-text-muted)]">A decision applies to every unchecked reading with this part code. J and K change part code. The label figure always wins: a correction sets the stored value with your note. Nothing is published from here.</p>
                </div>
              )}
            </section>

            <section className="flex min-h-0 min-w-0 flex-1 flex-col p-3" aria-label="Evidence">
              <div className="relative min-h-0 flex-1 overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]">
                {photo && (
                  <button type="button" onClick={() => setLightbox(true)} className="block h-full w-full cursor-zoom-in" aria-label="Open photo in full view">
                    {/* Supplier photo on its public image host; not downloaded. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={photo} alt={`Supplier photo of ${current.make} ${current.model}`} loading="eager" className="h-full w-full object-contain" />
                  </button>
                )}
                {photos.length > 1 && (
                  <>
                    <Button size="icon-sm" variant="outline" className="absolute left-2 top-1/2 -translate-y-1/2" onClick={() => step(-1)} aria-label="Previous photo"><ChevronLeftIcon /></Button>
                    <Button size="icon-sm" variant="outline" className="absolute right-2 top-1/2 -translate-y-1/2" onClick={() => step(1)} aria-label="Next photo"><ChevronRightIcon /></Button>
                  </>
                )}
                <Button size="xs" variant="outline" className="absolute right-2 top-2" onClick={() => setLightbox(true)}><MaximizeIcon /> Full view <kbd className="text-[10px] opacity-70">F</kbd></Button>
                <span className="absolute bottom-2 left-2 rounded bg-black/60 px-1.5 py-0.5 text-[11px] text-white">{photoIndex + 1} / {photos.length}{photo === current.photoUrl ? " · label photo" : ""}</span>
              </div>
              <div className="mt-2 flex shrink-0 gap-2 overflow-x-auto pb-1" role="group" aria-label="Photos">
                {photos.map((u, i) => (
                  <button key={u} type="button" onClick={() => { setShown(u); setZoomed(false); }} className={`h-20 w-28 shrink-0 overflow-hidden rounded border-2 ${u === photo ? "border-[var(--color-accent)]" : "border-[var(--color-border)]"}`} aria-label={i === 0 ? "Label photo" : `Photo ${i + 1}`} aria-current={u === photo}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={u} alt="" loading="lazy" className="h-full w-full object-cover" />
                  </button>
                ))}
              </div>
              <div className="mt-1 flex shrink-0 flex-wrap items-center gap-4 text-xs">
                {current.listingUrl && <a className="inline-flex items-center gap-1 text-[var(--color-accent)] hover:underline" href={current.listingUrl} target="_blank" rel="noopener noreferrer">Original listing <ExternalLinkIcon className="size-3" /></a>}
                <a className="inline-flex items-center gap-1 text-[var(--color-accent)] hover:underline" href={photo ?? current.photoUrl} target="_blank" rel="noopener noreferrer">Open photo in new tab <ExternalLinkIcon className="size-3" /></a>
                <span className="text-[11px] text-[var(--color-text-muted)]">Private: supplier links are for review only and never go to buyers.</span>
              </div>
            </section>
          </div>
        ) : (
          <p className="p-6 text-sm text-[var(--color-text-muted)]">Nothing in this filter.</p>
        )}
      </div>
      {lightbox && photo && (
        <div className="fixed inset-0 z-50 flex flex-col bg-black/92" role="dialog" aria-modal="true" aria-label="Photo full view">
          <div className="flex items-center gap-3 px-4 py-2 text-xs text-white">
            <span>{current?.make} {current?.model} · photo {photoIndex + 1} of {photos.length}</span>
            <span className="opacity-70">Arrow keys change photo, click the photo to zoom, Esc closes</span>
            <Button size="icon-sm" variant="outline" className="ml-auto" onClick={() => setLightbox(false)} aria-label="Close full view"><XIcon /></Button>
          </div>
          <div className={`relative min-h-0 flex-1 ${zoomed ? "overflow-auto" : "overflow-hidden"}`}>
            <button type="button" onClick={() => setZoomed((z) => !z)} className={zoomed ? "block cursor-zoom-out" : "flex h-full w-full cursor-zoom-in items-center justify-center"} aria-label={zoomed ? "Fit to screen" : "Zoom to full size"}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={photo} alt={`Full view, ${current?.make} ${current?.model}`} className={zoomed ? "max-w-none" : "max-h-full max-w-full object-contain"} style={zoomed ? { width: "220%" } : undefined} />
            </button>
            {photos.length > 1 && !zoomed && (
              <>
                <Button size="icon" variant="outline" className="fixed left-4 top-1/2 -translate-y-1/2" onClick={() => step(-1)} aria-label="Previous photo in full view"><ChevronLeftIcon /></Button>
                <Button size="icon" variant="outline" className="fixed right-4 top-1/2 -translate-y-1/2" onClick={() => step(1)} aria-label="Next photo in full view"><ChevronRightIcon /></Button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
