"use client";

import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { ArrowUpRight, Download } from "lucide-react";
import type { ArtifactRef } from "@/lib/mail-artifacts";
import { excerpt, type ArtifactOpenHandler } from "./mail-draft-card";

type Doc = Extract<ArtifactRef, { kind: "document" }>;
type Load = { status: "loading" } | { status: "error" } | { status: "ready"; content: string };

function useDocument(path: string): Load {
  const [state, setState] = useState<{ path: string; load: Load } | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      let load: Load;
      try {
        const res = await fetch(`/api/workspace/file?path=${encodeURIComponent(path)}`);
        load = res.ok ? { status: "ready", content: String(((await res.json()) as { content?: string }).content ?? "") } : { status: "error" };
      } catch {
        load = { status: "error" };
      }
      if (live) {setState({ path, load });}
    })();
    return () => { live = false; };
  }, [path]);
  return state?.path === path ? state.load : { status: "loading" };
}

/** First heading, else the file name. */
function titleOf(artifact: Doc, content: string | null): string {
  if (artifact.title) {return artifact.title;}
  const heading = content?.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading || artifact.path.split("/").pop() || "Document";
}

/** Inline chat card for a workspace document. Open edits it in the file editor tab; PDF prints it. */
export function DocumentCard({ artifact, onOpen }: { artifact: Doc; onOpen?: ArtifactOpenHandler }) {
  const load = useDocument(artifact.path);
  const reduceMotion = Boolean(useReducedMotion());
  const content = load.status === "ready" ? load.content : null;
  const title = titleOf(artifact, content);
  const snippet = excerpt(content?.replace(/^#.*$/gm, "").replace(/[*_`]/g, "") ?? null);
  const divider = { borderColor: "var(--color-border)" };
  const button = "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]";
  return (
    <motion.section
      aria-label={`Document: ${title}`}
      initial={reduceMotion ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.28, ease: [0.2, 0, 0, 1] }}
      className="not-prose my-3 w-full max-w-[560px] overflow-hidden rounded-[5px] border p-3.5 sm:p-4"
      style={{ borderColor: "var(--color-border-strong)", background: "var(--color-surface)", color: "var(--color-text)", boxShadow: "0 1px 2px rgba(0,0,0,0.04)" }}
    >
      <h3 className="text-[15px] font-semibold leading-snug tracking-tight [overflow-wrap:anywhere]">{title}</h3>
      <p className="mt-1 break-words font-mono text-[11px]" style={{ color: load.status === "error" ? "var(--color-error)" : "var(--color-text-muted)" }}>
        {load.status === "error" ? "This file was not found in the workspace." : artifact.path}
      </p>
      {snippet && <p className="mt-3 line-clamp-3 border-t pt-3 text-[13px] leading-relaxed [text-wrap:pretty]" style={{ ...divider, color: "var(--color-text-secondary)" }}>{snippet}</p>}
      <div className="mt-3 flex items-center justify-end gap-2 border-t pt-3" style={divider}>
        <a href={`/api/workspace/document-pdf?path=${encodeURIComponent(artifact.path)}`} download aria-label={`Download ${title} as PDF`}
          className={`${button} border hover:bg-[var(--color-surface-hover)]`} style={{ borderColor: "var(--color-border-strong)", color: "var(--color-text)", pointerEvents: load.status === "error" ? "none" : undefined, opacity: load.status === "error" ? 0.4 : undefined }}>
          <Download className="size-3.5" aria-hidden />
          PDF
        </a>
        <button type="button" onClick={() => { void onOpen?.(artifact.path, { title }); }} disabled={!onOpen || load.status === "error"} aria-label={`Open document: ${title}`}
          className={`group ${button} hover:bg-[var(--color-accent-fill-hover)] disabled:opacity-40`} style={{ background: "var(--color-accent-fill)", color: "var(--color-accent-foreground)" }}>
          Open document
          <ArrowUpRight className="size-3.5 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5 motion-reduce:transform-none" aria-hidden />
        </button>
      </div>
    </motion.section>
  );
}
