"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Code2 } from "lucide-react";
import { buildVisualDoc, VISUAL_THEME_VARS } from "@/lib/visual-blocks";

let counter = 0;

/**
 * A model-drawn SVG/HTML visual. Runs in an opaque-origin sandboxed iframe (scripts only: no cookies, storage,
 * parent access or network), themed with the host's colour tokens. `sendPrompt(text)` inside the drawing is relayed
 * as a pending suggestion the user confirms with one click, so a drawing can never post on its own.
 */
export function VisualBlock({ code, closed, onSendPrompt }: { code: string; closed: boolean; onSendPrompt?: (text: string) => void | Promise<void> }) {
  const id = useMemo(() => `visual-${++counter}`, []);
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(120);
  const [showSource, setShowSource] = useState(false);
  const [suggested, setSuggested] = useState<string | null>(null);
  const [doc, setDoc] = useState<string | null>(null);
  useEffect(() => {
    if (!closed) return;
    const style = getComputedStyle(document.documentElement);
    const vars = Object.fromEntries(VISUAL_THEME_VARS.map(name => [name, style.getPropertyValue(name).trim()]));
    setDoc(buildVisualDoc(code, vars, id));
  }, [closed, code, id]);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const data = event.data as { type?: string; id?: string; height?: number; text?: string } | null;
      if (!data || data.id !== id) return;
      if (data.type === "visual-height" && typeof data.height === "number") setHeight(Math.min(Math.max(Math.ceil(data.height), 40), 900));
      if (data.type === "visual-send" && typeof data.text === "string" && data.text.trim()) setSuggested(data.text.trim());
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [id]);
  return <figure data-visual-block className="group/visual relative my-2 overflow-hidden rounded-xl bg-[var(--color-surface-hover)]">
    {doc ? <iframe ref={frame} title="Drawing" sandbox="allow-scripts" srcDoc={doc} style={{ height }} className="block w-full border-0 transition-[height] duration-200 motion-reduce:transition-none" />
      : <div role="status" className="flex h-24 items-center justify-center text-[12px] text-[var(--color-text-muted)]"><span className="chat-shimmer-label">Drawing…</span></div>}
    <button type="button" aria-label="Toggle source" aria-pressed={showSource} onClick={() => setShowSource(value => !value)} className="absolute right-2 top-2 rounded-md p-1 text-[var(--color-text-muted)] opacity-0 transition hover:bg-[var(--color-border)] focus-visible:opacity-100 focus-visible:outline-2 group-hover/visual:opacity-100"><Code2 aria-hidden="true" className="size-3.5" /></button>
    {showSource && <pre className="max-h-60 overflow-auto whitespace-pre-wrap border-t border-[var(--color-border)] p-3 font-mono text-[11px] leading-5">{code}</pre>}
    {suggested && <div className="flex items-center gap-2 border-t border-[var(--color-border)] px-3 py-2 text-[12px]">
      <span className="min-w-0 flex-1 truncate text-[var(--color-text-muted)]">Send “{suggested}”?</span>
      <button type="button" className="rounded-md px-2 py-1 text-[var(--color-text-muted)] hover:bg-[var(--color-border)]" onClick={() => setSuggested(null)}>Dismiss</button>
      {onSendPrompt && <button type="button" className="rounded-md bg-[var(--color-accent)] px-2 py-1 font-medium text-[var(--color-accent-foreground,#fff)]" onClick={() => { void onSendPrompt(suggested); setSuggested(null); }}>Send</button>}
    </div>}
  </figure>;
}
