"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/** A small icon button that copies a listing's id (for telling an agent in chat which item you mean). Safe inside clickable rows. */
export function CopyIdButton({ id, className = "" }: { id: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  if (!id) return null;
  const Icon = copied ? Check : Copy;
  return (
    <button
      type="button"
      aria-label={copied ? "ID copied" : "Copy ID"}
      title={copied ? "Copied" : `Copy ID · ${id}`}
      onClick={async (event) => {
        event.stopPropagation();
        try { await navigator.clipboard.writeText(id); setCopied(true); } catch { setCopied(false); return; }
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1500);
      }}
      className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded align-middle transition-colors hover:bg-[var(--bt-segment)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--bt-text-2)] ${className}`}
      style={{ color: copied ? "var(--bt-green)" : "var(--bt-muted)" }}
    >
      <Icon size={12} aria-hidden />
    </button>
  );
}
