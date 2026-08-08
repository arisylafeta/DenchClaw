import {
  fetchComposioConnections,
  resolveComposioApiKey,
  resolveComposioGatewayUrl,
} from "@/lib/composio";
import { invalidateComposioConnectionsCache } from "../connections/cache";
import {
  extractComposioConnections,
  normalizeComposioConnections,
} from "@/lib/composio-client";
import {
  readOnboardingState,
  writeConnection,
  writeOnboardingState,
  type ConnectionRecord,
} from "@/lib/denchclaw-state";
import { refreshIntegrationsRuntime } from "@/lib/integrations";
import { resolveAppPublicOrigin } from "@/lib/public-origin";
import type { NormalizedComposioConnection } from "@/lib/composio";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function serializeForInlineScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function syncToolkitFromConnection(
  connection: NormalizedComposioConnection,
): "gmail" | "calendar" | null {
  if (connection.normalized_toolkit_slug === "gmail") {
    return "gmail";
  }
  if (
    connection.normalized_toolkit_slug === "google-calendar" ||
    connection.normalized_toolkit_slug === "googlecalendar"
  ) {
    return "calendar";
  }
  return null;
}

function persistLocalSyncConnection(connection: NormalizedComposioConnection): void {
  if (!connection.is_active) {
    return;
  }
  const toolkit = syncToolkitFromConnection(connection);
  if (!toolkit) {
    return;
  }

  const record: ConnectionRecord = {
    connectionId: connection.id,
    toolkitSlug: connection.normalized_toolkit_slug,
    accountEmail: connection.account_email ?? connection.account?.email ?? undefined,
    accountLabel: connection.display_label,
    connectedAt: new Date().toISOString(),
  };
  writeConnection(toolkit, record);

  const current = readOnboardingState();
  writeOnboardingState({
    ...current,
    connections: {
      ...current.connections,
      [toolkit]: record,
    },
  });
}

async function resolveConnectedConnection(
  connectedAccountId: string,
): Promise<NormalizedComposioConnection | null> {
  if (!connectedAccountId) {
    return null;
  }

  const apiKey = resolveComposioApiKey();
  if (!apiKey) {
    return null;
  }

  try {
    const connections = normalizeComposioConnections(
      extractComposioConnections(
        await fetchComposioConnections(resolveComposioGatewayUrl(), apiKey),
      ),
    );
    return connections.find((connection) => connection.id === connectedAccountId) ?? null;
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const { searchParams } = url;
  const status = searchParams.get("status") ?? "unknown";
  const connectedAccountId = searchParams.get("connected_account_id") ?? "";
  // Use the public origin (not `url.origin`) so the postMessage target
  // matches `window.location.origin` in the parent tab when ReBattery
  // is hosted behind a reverse proxy. The parent's strict
  // `event.origin === window.location.origin` check would otherwise
  // discard the message and the modal would hang on "Authorizing…".
  const targetOrigin = resolveAppPublicOrigin(request);

  const success = status === "success";
  let resolvedConnection:
    | Awaited<ReturnType<typeof resolveConnectedConnection>>
    | undefined;
  if (success) {
    invalidateComposioConnectionsCache();
    resolvedConnection = await resolveConnectedConnection(connectedAccountId);
    if (resolvedConnection) {
      persistLocalSyncConnection(resolvedConnection);
    }
    void (async () => {
      try {
        await refreshIntegrationsRuntime();
      } catch {}
    })();
  }
  const payloadJson = serializeForInlineScript({
    type: "composio-callback",
    status,
    connected_account_id: connectedAccountId,
    connected_toolkit_slug: resolvedConnection?.normalized_toolkit_slug ?? null,
    connected_toolkit_name: resolvedConnection?.toolkit_name ?? null,
    connected_status: resolvedConnection?.normalized_status ?? null,
  });
  const targetOriginJson = serializeForInlineScript(targetOrigin);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${success ? "Connected" : "Connection Failed"} — ReBattery</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #09090b; color: #fafafa;
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh; padding: 2rem;
    }
    .card {
      max-width: 420px; width: 100%; text-align: center;
      padding: 3rem 2rem; border-radius: 1rem;
      border: 1px solid #27272a; background: #18181b;
    }
    .icon { font-size: 3rem; margin-bottom: 1rem; }
    h1 { font-size: 1.25rem; font-weight: 600; margin-bottom: 0.5rem; }
    p { font-size: 0.875rem; color: #a1a1aa; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${success ? "&#10003;" : "&#10007;"}</div>
    <h1>${success ? "Connected successfully" : "Connection failed"}</h1>
    <p>${success ? "You can close this tab and return to ReBattery." : "Something went wrong. Please close this tab and try again."}</p>
  </div>
  <script>
    try {
      const payload = ${payloadJson};
      const targetOrigin = ${targetOriginJson};
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage(payload, targetOrigin);
        setTimeout(() => window.close(), 150);
      }
    } catch (_) {}
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
