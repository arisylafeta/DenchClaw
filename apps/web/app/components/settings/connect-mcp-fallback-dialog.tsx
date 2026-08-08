"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";

export type ConnectMcpFallbackInput = {
  authToken: string;
};

type ConnectMcpFallbackDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serverKey: string;
  serverUrl: string;
  /**
   * Called when the user submits a token. Returns an error message string to
   * display in the dialog, or null on success (which causes the dialog to
   * close).
   */
  onSubmit: (input: ConnectMcpFallbackInput) => Promise<string | null>;
  /**
   * If provided, surfaced above the input as context (e.g. the
   * `WWW-Authenticate` `error_description` from the server). Helps the user
   * understand why they're being asked for a token.
   */
  hint?: string | null;
};

export function ConnectMcpFallbackDialog({
  open,
  onOpenChange,
  serverKey,
  serverUrl,
  onSubmit,
  hint,
}: ConnectMcpFallbackDialogProps) {
  const tokenInputRef = useRef<HTMLInputElement>(null);
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    setToken("");
    setError(null);
    setSubmitting(false);
    setTimeout(() => tokenInputRef.current?.focus(), 100);
  }, [open]);

  const handleSubmit = async () => {
    if (!token.trim()) {
      setError("Please enter an access token.");
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const submitError = await onSubmit({ authToken: token.trim() });
      if (submitError) {
        setError(submitError);
        return;
      }
      onOpenChange(false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Connect to {serverKey}</DialogTitle>
          <DialogDescription>
            Paste an access token for this MCP server. It will be sent as an
            <code className="mx-1">Authorization: Bearer ...</code>
            header on every request.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div
            className="rounded-xl border px-3 py-2 text-xs leading-5"
            style={{
              borderColor: "var(--color-border)",
              background: "var(--color-surface)",
              color: "var(--color-text-muted)",
            }}
          >
            <div className="text-[11px] uppercase tracking-wide">Endpoint</div>
            <div className="mt-1 truncate" style={{ color: "var(--color-text)" }} title={serverUrl}>
              {serverUrl}
            </div>
          </div>

          {hint ? (
            <p
              className="rounded-lg px-3 py-2 text-xs leading-5"
              style={{
                background: "rgba(234, 179, 8, 0.08)",
                color: "var(--color-text-muted)",
              }}
            >
              Server says: {hint}
            </p>
          ) : null}

          <div>
            <label
              className="mb-1.5 block text-sm font-medium"
              style={{ color: "var(--color-text-secondary)" }}
            >
              Access token
            </label>
            <input
              ref={tokenInputRef}
              type="password"
              value={token}
              onChange={(event) => {
                setToken(event.target.value);
                setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !submitting) {
                  void handleSubmit();
                }
              }}
              placeholder="sk-..."
              className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
              style={{
                background: "var(--color-bg)",
                border: "1px solid var(--color-border)",
                color: "var(--color-text)",
              }}
            />
            <p className="mt-1 text-xs" style={{ color: "var(--color-text-muted)" }}>
              The <code>Bearer</code> prefix is added automatically.
            </p>
          </div>

          {error && (
            <p
              className="rounded-lg px-3 py-2 text-sm"
              style={{ background: "rgba(220, 38, 38, 0.08)", color: "var(--color-error)" }}
            >
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
            className="rounded-lg px-4"
            style={{ color: "var(--color-text-muted)", background: "transparent" }}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={submitting || !token.trim()}
            className="rounded-lg px-5"
            style={{ background: "var(--color-accent-fill)", color: "var(--color-accent-foreground)" }}
          >
            <span className="inline-flex items-center gap-2">
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              <span>{submitting ? "Connecting..." : "Connect"}</span>
            </span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
