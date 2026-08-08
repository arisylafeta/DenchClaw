import {
  getMcpServer,
  getMcpServerConfig,
  McpServerError,
  recordServerState,
} from "@/lib/mcp-servers";
import { probeMcpServer } from "@/lib/mcp-probe";
import {
  buildAuthorizationUrl,
  discoverOAuthMetadata,
  McpOAuthError,
  registerOAuthClient,
  type AuthorizationServerMetadata,
  type RegisteredClient,
} from "@/lib/mcp-oauth";
import { getMcpServerSecret, setMcpServerSecret } from "@/lib/mcp-secrets";
import { resolveAppPublicOrigin } from "@/lib/public-origin";
import { trackServer } from "@/lib/telemetry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type StartBody = {
  key?: unknown;
};

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

function notSupported(reason: string): Response {
  return Response.json({ supportsOAuth: false, reason });
}

function buildRedirectUri(request: Request): string {
  const origin = resolveAppPublicOrigin(request);
  return `${origin}/api/settings/mcp/connect/callback`;
}

/**
 * Reuse a previously cached client_id only when it still matches the same
 * authorization server and redirect URI. DCR clients are registered with a
 * fixed callback URL, so reusing one across localhost/tunnel/origin changes
 * can produce "redirect URL is invalid" during authorization.
 */
function maybeRehydrateClient(
  key: string,
  asMetadata: AuthorizationServerMetadata,
  asMetadataUrl: string,
  redirectUri: string,
): RegisteredClient | null {
  const cached = getMcpServerSecret(key);
  if (!cached || !cached.clientId) {
    return null;
  }
  if (cached.asMetadataUrl !== asMetadataUrl) {
    return null;
  }
  if (cached.authServerIssuer && cached.authServerIssuer !== asMetadata.issuer) {
    return null;
  }
  if (cached.registeredRedirectUri !== redirectUri) {
    return null;
  }
  return {
    clientId: cached.clientId,
    clientSecret: cached.clientSecret,
    registrationAccessToken: null,
    registrationClientUri: null,
  };
}

export async function POST(request: Request): Promise<Response> {
  let body: StartBody;
  try {
    body = (await request.json()) as StartBody;
  } catch {
    return jsonError("Invalid JSON body.", 400);
  }
  if (typeof body.key !== "string") {
    return jsonError("Field 'key' must be a string.", 400);
  }
  const key = body.key;

  let serverEntry;
  try {
    serverEntry = getMcpServer(key);
  } catch (err) {
    if (err instanceof McpServerError) {
      return jsonError(err.message, err.status);
    }
    return jsonError(
      err instanceof Error ? err.message : "Failed to load MCP server.",
      500,
    );
  }
  if (!serverEntry) {
    return jsonError(`MCP server '${key}' was not found.`, 404);
  }

  trackServer("mcp_connect_started", {
    key,
    method: "oauth",
  });

  const serverConfig = getMcpServerConfig(key);
  if (!serverConfig) {
    return jsonError(`MCP server '${key}' is missing wire config.`, 500);
  }

  // Step 1: probe the MCP server. We need the live WWW-Authenticate header
  // because the user might have rotated auth servers since the last probe.
  const probe = await probeMcpServer({
    url: serverConfig.url,
    headers: serverConfig.headers,
  });

  if (probe.status === "connected") {
    // Already connected — record fresh state and tell the UI nothing to do.
    recordServerState(key, {
      state: "connected",
      toolCount: probe.toolCount,
      detail: probe.detail,
      checkedAt: probe.checkedAt,
    });
    return Response.json({
      alreadyConnected: true,
      server: getMcpServer(key),
    });
  }

  if (probe.status === "error") {
    recordServerState(key, {
      state: "error",
      detail: probe.detail,
      checkedAt: probe.checkedAt,
    });
    trackServer("mcp_connect_failed", {
      key,
      reason: "probe_error",
    });
    return notSupported(`The server is not reachable: ${probe.detail}`);
  }

  const challenge = probe.authChallenge;
  const resourceMetadataUrl = challenge?.resourceMetadataUrl ?? null;
  if (!resourceMetadataUrl) {
    recordServerState(key, {
      state: "needs_auth",
      detail: probe.detail,
      checkedAt: probe.checkedAt,
    });
    trackServer("mcp_connect_failed", {
      key,
      reason: "no_oauth_metadata",
    });
    return notSupported(
      "The server did not advertise an OAuth resource metadata URL. Use a manual access token instead.",
    );
  }

  // Step 2: walk RFC 9728 + RFC 8414 discovery.
  let discovered;
  try {
    discovered = await discoverOAuthMetadata(resourceMetadataUrl);
  } catch (err) {
    const reason = err instanceof McpOAuthError
      ? err.reason
      : "discovery_failed";
    const detail = err instanceof Error ? err.message : "Discovery failed.";
    recordServerState(key, {
      state: "needs_auth",
      detail,
      checkedAt: new Date().toISOString(),
    });
    trackServer("mcp_connect_failed", {
      key,
      reason,
    });
    return notSupported(`OAuth discovery failed (${reason}): ${detail}`);
  }

  const redirectUri = buildRedirectUri(request);
  const scope = discovered.resource.scopesSupported.length > 0
    ? discovered.resource.scopesSupported.join(" ")
    : (challenge?.scope ?? null);

  // Step 3: register (or reuse) an OAuth client.
  let client = maybeRehydrateClient(
    key,
    discovered.authServer,
    resourceMetadataUrl,
    redirectUri,
  );
  if (!client) {
    try {
      client = await registerOAuthClient({
        asMetadata: discovered.authServer,
        redirectUri,
        clientName: `ReBattery (${key})`,
        scope,
      });
    } catch (err) {
      const reason = err instanceof McpOAuthError
        ? err.reason
        : "registration_failed";
      const detail = err instanceof Error ? err.message : "Registration failed.";
      trackServer("mcp_connect_failed", {
        key,
        reason,
      });
      return notSupported(`Dynamic client registration failed (${reason}): ${detail}`);
    }
  }

  // Step 4: build the authorization URL with PKCE + state.
  const authParams = buildAuthorizationUrl({
    asMetadata: discovered.authServer,
    client,
    redirectUri,
    scope,
    resource: discovered.resource.resource,
  });

  // Step 5: persist everything we'll need at the callback step.
  setMcpServerSecret(key, {
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    asMetadataUrl: resourceMetadataUrl,
    authServerIssuer: discovered.authServer.issuer,
    registeredRedirectUri: redirectUri,
    codeVerifier: authParams.codeVerifier,
    oauthState: authParams.state,
    redirectUri: authParams.redirectUri,
    scope: authParams.scope,
  });

  return Response.json({
    supportsOAuth: true,
    authorizationUrl: authParams.authorizationUrl,
    redirectUri,
    issuer: discovered.authServer.issuer,
  });
}
