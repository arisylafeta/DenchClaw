"use client";

/**
 * Inline "Add a Custom MCP Server" affordance.
 *
 * Replaces the older two-screen flow (modal → row appears → click Connect)
 * with a single inline row that mirrors Cursor's MCP UI:
 *
 *   1. Collapsed state — a tappable row at the bottom of the server list,
 *      visually consistent with the existing server rows so it reads as
 *      "the next thing in the list" rather than as a button.
 *   2. Expanded state — the same row grows into a small inline form with
 *      Server name + Server URL + a single Connect button. Connect is
 *      disabled until both fields are non-empty so the affordance only
 *      activates when there's something real to send.
 *
 * The component is purely presentational: it owns its own form state and
 * collapse/expand flag, but the actual save+OAuth work runs in the parent
 * (`McpServersSection`) via the `onAddAndConnect` callback. The parent is
 * responsible for the existing OAuth popup / fallback-token plumbing.
 */

import { useEffect, useRef, useState } from "react";
import { Loader2, Plus, Server } from "lucide-react";
import { Button } from "../ui/button";

export type AddMcpServerInlineInput = {
  key: string;
  url: string;
};

export type AddMcpServerInlineResult =
  | { ok: true }
  | { ok: false; error: string };

type AddMcpServerInlineProps = {
  /**
   * Save the server and immediately start the connect flow. The inline form
   * stays expanded with `error` shown on `{ ok: false }`, and collapses on
   * `{ ok: true }`. The parent handles the popup / fallback dialog after the
   * row lands in the list — by that point this form is gone.
   */
  onAddAndConnect: (input: AddMcpServerInlineInput) => Promise<AddMcpServerInlineResult>;
  /**
   * When true, the parent has another action in flight that should block
   * adding (e.g. an existing row is being deleted). The inline form
   * disables interaction without collapsing.
   */
  disabled?: boolean;
};

export function AddMcpServerInline({
  onAddAndConnect,
  disabled = false,
}: AddMcpServerInlineProps) {
  const [expanded, setExpanded] = useState(false);
  const [key, setKey] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const keyInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (expanded) {
      setTimeout(() => keyInputRef.current?.focus(), 50);
    }
  }, [expanded]);

  const trimmedKey = key.trim();
  const trimmedUrl = url.trim();
  const canSubmit = trimmedKey.length > 0 && trimmedUrl.length > 0 && !submitting && !disabled;

  const collapse = () => {
    setExpanded(false);
    setKey("");
    setUrl("");
    setError(null);
    setSubmitting(false);
  };

  const handleSubmit = async () => {
    if (!canSubmit) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await onAddAndConnect({ key: trimmedKey, url: trimmedUrl });
      if (result.ok) {
        collapse();
      } else {
        setError(result.error);
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => {
          if (!disabled) {
            setExpanded(true);
          }
        }}
        disabled={disabled}
        className="flex w-full items-center gap-3 rounded-xl border px-4 py-4 text-left transition-colors hover:bg-[var(--color-surface-hover)] disabled:opacity-50"
        style={{
          borderColor: "var(--color-border)",
          background: "var(--color-surface)",
        }}
      >
        <div
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg"
          style={{
            background: "var(--color-surface-hover)",
            color: "var(--color-text)",
          }}
        >
          <Plus className="h-5 w-5" aria-hidden />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-medium" style={{ color: "var(--color-text)" }}>
            New MCP Server
          </div>
          <div className="mt-0.5 text-xs leading-5" style={{ color: "var(--color-text-muted)" }}>
            Add a Custom MCP Server
          </div>
        </div>
      </button>
    );
  }

  return (
    <div
      className="rounded-xl border px-4 py-4"
      style={{
        borderColor: "var(--color-border)",
        background: "var(--color-surface)",
      }}
    >
      <div className="flex items-start gap-3">
        <div
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg"
          style={{
            background: "var(--color-surface-hover)",
            color: "var(--color-text)",
          }}
        >
          <Server className="h-5 w-5" aria-hidden />
        </div>
        <div className="min-w-0 flex-1 space-y-3">
          <div className="text-sm font-medium" style={{ color: "var(--color-text)" }}>
            New MCP Server
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label
                htmlFor="mcp-inline-key"
                className="mb-1 block text-[11px] uppercase tracking-wide"
                style={{ color: "var(--color-text-muted)" }}
              >
                Server name
              </label>
              <input
                id="mcp-inline-key"
                ref={keyInputRef}
                type="text"
                value={key}
                onChange={(event) => {
                  setKey(event.target.value);
                  setError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void handleSubmit();
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    collapse();
                  }
                }}
                placeholder="e.g. stripe"
                disabled={submitting}
                className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
                style={{
                  background: "var(--color-bg)",
                  border: "1px solid var(--color-border)",
                  color: "var(--color-text)",
                }}
                autoComplete="off"
                spellCheck={false}
              />
            </div>

            <div>
              <label
                htmlFor="mcp-inline-url"
                className="mb-1 block text-[11px] uppercase tracking-wide"
                style={{ color: "var(--color-text-muted)" }}
              >
                Server URL
              </label>
              <input
                id="mcp-inline-url"
                type="url"
                value={url}
                onChange={(event) => {
                  setUrl(event.target.value);
                  setError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void handleSubmit();
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    collapse();
                  }
                }}
                placeholder="https://mcp.example.com"
                disabled={submitting}
                className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
                style={{
                  background: "var(--color-bg)",
                  border: "1px solid var(--color-border)",
                  color: "var(--color-text)",
                }}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          </div>

          {error && (
            <p
              className="rounded-lg px-3 py-2 text-xs"
              style={{
                background: "rgba(220, 38, 38, 0.08)",
                color: "var(--color-error)",
              }}
            >
              {error}
            </p>
          )}

          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="rounded-lg"
              onClick={collapse}
              disabled={submitting}
              style={{ color: "var(--color-text-muted)", background: "transparent" }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              className="rounded-lg"
              onClick={() => void handleSubmit()}
              disabled={!canSubmit}
              style={{
                background: canSubmit ? "var(--color-accent-fill)" : "var(--color-surface-hover)",
                color: canSubmit ? "var(--color-accent-foreground)" : "var(--color-text-muted)",
              }}
            >
              <span className="inline-flex items-center gap-2">
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                <span>{submitting ? "Connecting…" : "Connect"}</span>
              </span>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
