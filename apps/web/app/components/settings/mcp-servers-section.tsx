"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RotateCcw,
  Server,
  ShieldCheck,
  ShieldOff,
  Trash2,
} from "lucide-react";
import { Button } from "../ui/button";
import {
  AddMcpServerInline,
  type AddMcpServerInlineInput,
  type AddMcpServerInlineResult,
} from "./add-mcp-server-inline";
import {
  ConnectMcpFallbackDialog,
  type ConnectMcpFallbackInput,
} from "./connect-mcp-fallback-dialog";

type McpServerState = "untested" | "connected" | "needs_auth" | "error";

type McpServerEntry = {
  key: string;
  url: string;
  transport: string;
  hasAuth: boolean;
  state: McpServerState;
  toolCount: number | null;
  lastCheckedAt: string | null;
  lastDetail: string | null;
};

type ActionNotice = {
  tone: "success" | "error";
  message: string;
};

function NoticeBanner({ notice }: { notice: ActionNotice }) {
  const toneClass = notice.tone === "success"
    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
    : "border-red-500/30 bg-red-500/10 text-red-300";

  return (
    <div className={`rounded-xl border px-4 py-3 text-sm ${toneClass}`}>
      {notice.message}
    </div>
  );
}

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const payload = await response.json() as { error?: unknown };
    return typeof payload.error === "string" && payload.error.trim().length > 0
      ? payload.error
      : fallback;
  } catch {
    return fallback;
  }
}

function sortServers(servers: McpServerEntry[]): McpServerEntry[] {
  return [...servers].toSorted((a, b) => a.key.localeCompare(b.key));
}

function upsertServer(
  servers: McpServerEntry[],
  next: McpServerEntry,
): McpServerEntry[] {
  const without = servers.filter((entry) => entry.key !== next.key);
  return sortServers([...without, next]);
}

type ConnectTarget = {
  serverKey: string;
  serverUrl: string;
  hint: string | null;
};

type OAuthCallbackMessage = {
  source?: unknown;
  type?: unknown;
  serverKey?: unknown;
  reason?: unknown;
  description?: unknown;
};

const OAUTH_POPUP_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Wait for the OAuth callback page to postMessage back, the popup to close
 * (user dismissed without completing), or a timeout. Resolves either way —
 * the caller probes the server afterward to figure out what actually
 * happened.
 */
async function waitForOAuthOutcome(serverKey: string, popup: Window): Promise<void> {
  return await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      window.removeEventListener("message", handleMessage);
      clearInterval(closedPoll);
      clearTimeout(timeout);
      resolve();
    };

    const handleMessage = (event: MessageEvent) => {
      if (event.source !== popup) {
        return;
      }
      const data = event.data as OAuthCallbackMessage | null;
      if (!data || data.source !== "denchclaw.mcp.connect") {
        return;
      }
      if (typeof data.serverKey !== "string" || data.serverKey !== serverKey) {
        return;
      }
      try {
        popup.close();
      } catch {
        // ignore
      }
      finish();
    };

    window.addEventListener("message", handleMessage);
    const closedPoll = window.setInterval(() => {
      if (popup.closed) {
        finish();
      }
    }, 500);
    const timeout = window.setTimeout(() => {
      try {
        popup.close();
      } catch {
        // ignore
      }
      finish();
    }, OAUTH_POPUP_TIMEOUT_MS);
  });
}

export function McpServersSection() {
  const [servers, setServers] = useState<McpServerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<ActionNotice | null>(null);
  const [connectTarget, setConnectTarget] = useState<ConnectTarget | null>(null);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const hydratedProbeKeysRef = useRef<Set<string>>(new Set());

  const fetchServers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/settings/mcp");
      if (!response.ok) {
        throw new Error(await readErrorMessage(response, `Failed to load MCP servers (${response.status}).`));
      }
      const payload = await response.json() as { servers?: McpServerEntry[] };
      setServers(sortServers(Array.isArray(payload.servers) ? payload.servers : []));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load MCP servers.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchServers();
  }, [fetchServers]);

  const handleProbeServer = useCallback(async (server: McpServerEntry) => {
    setBusyKey(server.key);
    setNotice(null);
    try {
      const response = await fetch("/api/settings/mcp/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: server.key }),
      });
      if (!response.ok) {
        throw new Error(await readErrorMessage(response, "Probe failed."));
      }
      const payload = await response.json() as { server?: McpServerEntry };
      if (payload.server) {
        setServers((current) => upsertServer(current, payload.server as McpServerEntry));
      }
    } catch (err) {
      setNotice({
        tone: "error",
        message: err instanceof Error ? err.message : "Probe failed.",
      });
    } finally {
      setBusyKey(null);
    }
  }, []);

  const openFallbackDialog = useCallback((server: McpServerEntry, hint: string | null) => {
    setConnectTarget({
      serverKey: server.key,
      serverUrl: server.url,
      hint,
    });
  }, []);

  const refreshServer = useCallback(async (
    serverKey: string,
    options?: { showSuccessNotice?: boolean },
  ) => {
    try {
      const response = await fetch("/api/settings/mcp/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: serverKey }),
      });
      if (!response.ok) {
        return;
      }
      const payload = await response.json() as { server?: McpServerEntry };
      if (payload.server) {
        setServers((current) => upsertServer(current, payload.server as McpServerEntry));
        if (options?.showSuccessNotice !== false && payload.server.state === "connected") {
          setNotice({
            tone: "success",
            message: `Connected '${serverKey}'.`,
          });
        }
      }
    } catch {
      // ignore — the row state will surface the error on the next probe
    }
  }, []);

  useEffect(() => {
    const currentKeys = new Set(servers.map((server) => server.key));
    for (const hydratedKey of hydratedProbeKeysRef.current) {
      if (!currentKeys.has(hydratedKey)) {
        hydratedProbeKeysRef.current.delete(hydratedKey);
      }
    }

    if (loading || servers.length === 0) {
      return;
    }

    for (const server of servers) {
      if (hydratedProbeKeysRef.current.has(server.key)) {
        continue;
      }
      hydratedProbeKeysRef.current.add(server.key);
      void refreshServer(server.key, { showSuccessNotice: false });
    }
  }, [loading, refreshServer, servers]);

  const handleConnectClick = useCallback(
    async (server: McpServerEntry): Promise<void> => {
      setBusyKey(server.key);
      setNotice(null);

      try {
        const response = await fetch("/api/settings/mcp/connect/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: server.key }),
        });
        if (!response.ok) {
          const message = await readErrorMessage(response, "Failed to start Connect.");
          openFallbackDialog(server, message);
          return;
        }
        const payload = await response.json() as {
          supportsOAuth?: boolean;
          alreadyConnected?: boolean;
          authorizationUrl?: string;
          reason?: string;
          server?: McpServerEntry;
        };

        if (payload.alreadyConnected && payload.server) {
          setServers((current) => upsertServer(current, payload.server as McpServerEntry));
          setNotice({
            tone: "success",
            message: `'${server.key}' is already connected.`,
          });
          return;
        }

        if (payload.supportsOAuth === false) {
          openFallbackDialog(server, payload.reason ?? server.lastDetail);
          return;
        }

        if (!payload.authorizationUrl) {
          openFallbackDialog(server, "OAuth start did not return an authorization URL.");
          return;
        }

        // Open the AS authorization URL in a popup. The callback page will
        // postMessage back to us when it's done.
        const popup = window.open(
          payload.authorizationUrl,
          `mcp-connect-${server.key}`,
          "popup=yes,width=520,height=720,noopener=no",
        );
        if (!popup) {
          openFallbackDialog(
            server,
            "The browser blocked the OAuth popup. Allow popups and try again, or paste a token instead.",
          );
          return;
        }

        await waitForOAuthOutcome(server.key, popup);
        await refreshServer(server.key);
      } catch (err) {
        openFallbackDialog(
          server,
          err instanceof Error ? err.message : "Connect failed.",
        );
      } finally {
        setBusyKey(null);
      }
    },
    [openFallbackDialog, refreshServer],
  );

  // Inline "New MCP Server" submit: save the row, then immediately kick
  // off the existing OAuth/connect flow on it. The inline form collapses
  // as soon as the row exists in the list — the OAuth popup, busy state,
  // and final probe result then surface on the row itself, so the user
  // never has to click Connect a second time.
  const handleAddAndConnect = useCallback(
    async (input: AddMcpServerInlineInput): Promise<AddMcpServerInlineResult> => {
      setNotice(null);
      try {
        const response = await fetch("/api/settings/mcp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        });

        if (!response.ok) {
          return {
            ok: false,
            error: await readErrorMessage(response, "Failed to add MCP server."),
          };
        }

        const payload = await response.json() as { server?: McpServerEntry };
        const newServer = payload.server;
        if (!newServer) {
          return {
            ok: false,
            error: "Server was added but the response was malformed.",
          };
        }

        hydratedProbeKeysRef.current.delete(newServer.key);
        setServers((current) => upsertServer(current, newServer));

        // Fire-and-forget: continue the connect flow on the new row. The
        // inline form returns ok now so it can collapse, and the row's own
        // busy/Connect/Retry affordances cover everything from here.
        void handleConnectClick(newServer);

        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : "Failed to add MCP server.",
        };
      }
    },
    [handleConnectClick],
  );

  const handleConnectSubmit = useCallback(
    async (input: ConnectMcpFallbackInput) => {
      if (!connectTarget) {
        return "No server selected.";
      }
      try {
        const response = await fetch("/api/settings/mcp/connect/token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            key: connectTarget.serverKey,
            authToken: input.authToken,
          }),
        });
        if (!response.ok) {
          return await readErrorMessage(response, "Failed to connect.");
        }
        const payload = await response.json() as {
          server?: McpServerEntry;
          probe?: { status?: McpServerState; detail?: string };
        };
        if (payload.server) {
          setServers((current) => upsertServer(current, payload.server as McpServerEntry));
        }

        const probeStatus = payload.probe?.status;
        if (probeStatus === "connected") {
          setNotice({
            tone: "success",
            message: `Connected to '${connectTarget.serverKey}'.`,
          });
          return null;
        }

        // The token was saved but the probe said it didn't grant access.
        // Show the server's hint inline instead of closing the dialog.
        return payload.probe?.detail
          ?? "The token was saved but the server still rejected the connection.";
      } catch (err) {
        return err instanceof Error ? err.message : "Failed to connect.";
      }
    },
    [connectTarget],
  );

  const handleDeleteServer = useCallback(async (server: McpServerEntry) => {
    const confirmed = window.confirm(`Remove MCP server '${server.key}'?`);
    if (!confirmed) {
      return;
    }

    setDeletingKey(server.key);
    setNotice(null);

    try {
      const response = await fetch("/api/settings/mcp", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: server.key }),
      });

      if (!response.ok) {
        throw new Error(await readErrorMessage(response, "Failed to remove MCP server."));
      }

      setServers((current) => current.filter((entry) => entry.key !== server.key));
      setNotice({ tone: "success", message: `Removed MCP server '${server.key}'.` });
    } catch (err) {
      setNotice({
        tone: "error",
        message: err instanceof Error ? err.message : "Failed to remove MCP server.",
      });
    } finally {
      setDeletingKey(null);
    }
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium" style={{ color: "var(--color-text)" }}>
            MCP Servers
          </h2>
          <p className="mt-1 text-xs leading-5" style={{ color: "var(--color-text-muted)" }}>
            Connect remote MCP servers to expose additional tools in ReBattery.
          </p>
        </div>
      </div>

      {notice ? <NoticeBanner notice={notice} /> : null}

      {loading ? (
        <div className="flex items-center justify-center py-10">
          <div
            className="h-6 w-6 animate-spin rounded-full border-2"
            style={{ borderColor: "var(--color-border)", borderTopColor: "var(--color-accent)" }}
          />
        </div>
      ) : error ? (
        <div
          className="rounded-xl border px-4 py-6 text-center"
          style={{ borderColor: "var(--color-border)" }}
        >
          <p className="mb-3 text-sm" style={{ color: "var(--color-text-muted)" }}>
            {error}
          </p>
          <Button type="button" variant="outline" onClick={() => void fetchServers()}>
            Retry
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {servers.map((server) => (
            <McpServerRow
              key={server.key}
              server={server}
              busy={busyKey === server.key}
              deleting={deletingKey === server.key}
              onConnect={() => handleConnectClick(server)}
              onRetry={() => void handleProbeServer(server)}
              onDelete={() => void handleDeleteServer(server)}
            />
          ))}
          <AddMcpServerInline onAddAndConnect={handleAddAndConnect} />
        </div>
      )}

      {connectTarget ? (
        <ConnectMcpFallbackDialog
          open={Boolean(connectTarget)}
          onOpenChange={(open) => {
            if (!open) {
              setConnectTarget(null);
            }
          }}
          serverKey={connectTarget.serverKey}
          serverUrl={connectTarget.serverUrl}
          hint={connectTarget.hint}
          onSubmit={handleConnectSubmit}
        />
      ) : null}
    </div>
  );
}

type McpServerRowProps = {
  server: McpServerEntry;
  busy: boolean;
  deleting: boolean;
  onConnect: () => void;
  onRetry: () => void;
  onDelete: () => void;
};

function McpServerRow({
  server,
  busy,
  deleting,
  onConnect,
  onRetry,
  onDelete,
}: McpServerRowProps) {
  return (
    <div
      className="rounded-xl border px-4 py-4"
      style={{
        borderColor: "var(--color-border)",
        background: "var(--color-surface)",
      }}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 gap-3">
          <div
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg"
            style={{ background: "var(--color-surface-hover)", color: "var(--color-text)" }}
          >
            <Server className="h-5 w-5" aria-hidden />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <div className="truncate text-sm font-medium" style={{ color: "var(--color-text)" }}>
                {server.key}
              </div>
              <ServerStateBadge server={server} />
              <span
                className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium"
                style={{
                  background: "var(--color-surface-hover)",
                  color: "var(--color-text)",
                }}
              >
                {server.hasAuth ? (
                  <ShieldCheck className="h-3 w-3" aria-hidden />
                ) : (
                  <ShieldOff className="h-3 w-3" aria-hidden />
                )}
                <span>{server.hasAuth ? "Authenticated" : "No auth"}</span>
              </span>
            </div>
            <p className="mt-2 text-[11px] uppercase tracking-wide" style={{ color: "var(--color-text-muted)" }}>
              Remote endpoint
            </p>
            <div
              className="mt-1 truncate text-xs leading-5"
              style={{ color: "var(--color-text-muted)" }}
              title={server.url}
            >
              {server.url}
            </div>
            {server.lastDetail && server.state !== "connected" ? (
              <div
                className="mt-2 text-xs leading-5"
                style={{ color: "var(--color-text-muted)" }}
                title={server.lastDetail}
              >
                {server.lastDetail}
              </div>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <ServerActionButton
            server={server}
            busy={busy}
            onConnect={onConnect}
            onRetry={onRetry}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="rounded-lg"
            onClick={onDelete}
            disabled={deleting}
            aria-label={`Remove ${server.key}`}
            style={{ color: "var(--color-text-muted)" }}
          >
            {deleting ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Trash2 className="h-4 w-4" aria-hidden />
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ServerStateBadge({ server }: { server: McpServerEntry }) {
  const baseClass = "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium";

  if (server.state === "connected") {
    const count = server.toolCount ?? 0;
    return (
      <span
        className={baseClass}
        style={{
          background: "rgba(16, 185, 129, 0.12)",
          color: "rgb(110, 231, 183)",
        }}
      >
        <CheckCircle2 className="h-3 w-3" aria-hidden />
        <span>
          {count} tool{count === 1 ? "" : "s"} enabled
        </span>
      </span>
    );
  }

  if (server.state === "needs_auth") {
    return (
      <span
        className={baseClass}
        style={{
          background: "rgba(234, 179, 8, 0.12)",
          color: "rgb(252, 211, 77)",
        }}
      >
        <ShieldOff className="h-3 w-3" aria-hidden />
        <span>Needs authentication</span>
      </span>
    );
  }

  if (server.state === "error") {
    return (
      <span
        className={baseClass}
        style={{
          background: "rgba(239, 68, 68, 0.12)",
          color: "rgb(252, 165, 165)",
        }}
      >
        <AlertTriangle className="h-3 w-3" aria-hidden />
        <span>Error</span>
      </span>
    );
  }

  return (
    <span
      className={baseClass}
      style={{
        background: "var(--color-surface-hover)",
        color: "var(--color-text-muted)",
      }}
    >
      {server.transport}
    </span>
  );
}

type ServerActionButtonProps = {
  server: McpServerEntry;
  busy: boolean;
  onConnect: () => void;
  onRetry: () => void;
};

function ServerActionButton({ server, busy, onConnect, onRetry }: ServerActionButtonProps) {
  if (server.state === "connected") {
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="rounded-lg"
        onClick={onRetry}
        disabled={busy}
        aria-label={`Re-check ${server.key}`}
        style={{ color: "var(--color-text-muted)" }}
      >
        {busy ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        ) : (
          <RotateCcw className="h-4 w-4" aria-hidden />
        )}
      </Button>
    );
  }

  if (server.state === "error") {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="rounded-lg"
        onClick={onRetry}
        disabled={busy}
      >
        {busy ? (
          <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden />
        ) : null}
        Retry
      </Button>
    );
  }

  // needs_auth or untested → Connect
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="rounded-lg"
      onClick={onConnect}
      disabled={busy}
    >
      {busy ? (
        <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden />
      ) : null}
      Connect
    </Button>
  );
}
