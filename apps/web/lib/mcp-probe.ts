/**
 * MCP server probe — performs a JSON-RPC `tools/list` call against a remote
 * MCP server over streamable-http and classifies the response into one of
 * three states:
 *
 *   - "connected"   : 200 OK with a parseable tool list. Returns the count.
 *   - "needs_auth"  : 401/403, optionally with an RFC 9728 WWW-Authenticate
 *                     challenge that Phase 2 (OAuth) consumes for discovery.
 *   - "error"       : anything else (network failure, malformed response,
 *                     non-auth HTTP error, etc.).
 *
 * Handles both `application/json` and `text/event-stream` response bodies,
 * because some MCP servers return SSE-framed JSON-RPC messages even for a
 * simple `tools/list` reply.
 *
 * Handles SSE and JSON responses without depending on a provider-specific client.
 */

type UnknownRecord = Record<string, unknown>;

export type McpProbeStatus = "connected" | "needs_auth" | "error";

/**
 * Parsed `WWW-Authenticate: Bearer ...` challenge per RFC 6750 / RFC 9728.
 *
 * `resourceMetadataUrl` is the RFC 9728 hint that Phase 2 follows to discover
 * the protected-resource metadata document. If missing, the server doesn't
 * advertise OAuth and the UI should fall back to manual token entry.
 */
export type McpAuthChallenge = {
  scheme: string;
  realm: string | null;
  resourceMetadataUrl: string | null;
  scope: string | null;
  errorCode: string | null;
  errorDescription: string | null;
};

export type McpProbeResult = {
  status: McpProbeStatus;
  toolCount: number | null;
  authChallenge: McpAuthChallenge | null;
  detail: string;
  checkedAt: string;
  httpStatus: number | null;
};

export type McpProbeOptions = {
  url: string;
  headers?: Record<string, string>;
  fetcher?: typeof fetch;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 15_000;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Parse a single `WWW-Authenticate` header value. Accepts the most common
 * Bearer-challenge shapes:
 *
 *   Bearer
 *   Bearer realm="acme"
 *   Bearer realm="acme", error="invalid_token", error_description="expired"
 *   Bearer resource_metadata="https://...", scope="mcp:read"
 *
 * Multi-scheme headers (e.g. `Basic ..., Bearer ...`) are not common for MCP
 * servers; we only return the first Bearer challenge we find. Anything else
 * yields `null`.
 */
export function parseWwwAuthenticate(header: string | null): McpAuthChallenge | null {
  if (!header) {
    return null;
  }

  const trimmed = header.trim();
  if (!trimmed) {
    return null;
  }

  const bearerMatch = /(?:^|,\s*)Bearer\b\s*(.*)$/iu.exec(trimmed);
  if (!bearerMatch) {
    return null;
  }

  const paramsRaw = bearerMatch[1] ?? "";
  const params = new Map<string, string>();
  let buffer = "";
  let inQuotes = false;
  const segments: string[] = [];
  for (const ch of paramsRaw) {
    if (ch === "\"") {
      inQuotes = !inQuotes;
      buffer += ch;
    } else if (ch === "," && !inQuotes) {
      segments.push(buffer);
      buffer = "";
    } else {
      buffer += ch;
    }
  }
  if (buffer.trim()) {
    segments.push(buffer);
  }

  for (const segment of segments) {
    const eqIndex = segment.indexOf("=");
    if (eqIndex === -1) {
      continue;
    }
    const rawKey = segment.slice(0, eqIndex).trim();
    let rawValue = segment.slice(eqIndex + 1).trim();
    if (!rawKey) {
      continue;
    }
    if (rawValue.startsWith("\"") && rawValue.endsWith("\"") && rawValue.length >= 2) {
      rawValue = rawValue.slice(1, -1).replace(/\\"/g, "\"");
    }
    params.set(rawKey.toLowerCase(), rawValue);
  }

  return {
    scheme: "Bearer",
    realm: params.get("realm") ?? null,
    resourceMetadataUrl: params.get("resource_metadata") ?? null,
    scope: params.get("scope") ?? null,
    errorCode: params.get("error") ?? null,
    errorDescription: params.get("error_description") ?? null,
  };
}

function extractToolCountFromJsonRpcMessage(payload: unknown): number | null {
  const rec = asRecord(payload);
  const result = asRecord(rec?.result);
  const tools = result?.tools;
  if (!Array.isArray(tools)) {
    return null;
  }
  return tools.filter((item) => readString(asRecord(item)?.name)).length;
}

function parseSseToolCount(body: string): number | null {
  let lastPayload: unknown = null;
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) {
      continue;
    }
    const raw = trimmed.slice(5).trim();
    if (raw === "[DONE]" || raw === "") {
      continue;
    }
    try {
      lastPayload = JSON.parse(raw);
    } catch {
      // ignore non-JSON SSE frames
    }
  }
  return lastPayload === null ? null : extractToolCountFromJsonRpcMessage(lastPayload);
}

async function parseToolsListResponse(res: Response): Promise<number | null> {
  const contentType = res.headers.get("content-type") ?? "";
  const text = await res.text();
  if (contentType.includes("text/event-stream")) {
    const fromSse = parseSseToolCount(text);
    if (fromSse !== null) {
      return fromSse;
    }
  }
  try {
    const fromJson = extractToolCountFromJsonRpcMessage(JSON.parse(text) as unknown);
    if (fromJson !== null) {
      return fromJson;
    }
  } catch {
    // fall through to SSE parsing
  }
  return parseSseToolCount(text);
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Probe a remote MCP server with a JSON-RPC `tools/list` request and return
 * a structured classification of the response. Never throws — network errors
 * and malformed responses are mapped to `status: "error"`.
 */
export async function probeMcpServer(options: McpProbeOptions): Promise<McpProbeResult> {
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const checkedAt = nowIso();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetcher(options.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...options.headers,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
      signal: controller.signal,
    });

    if (response.status === 401 || response.status === 403) {
      const wwwAuthenticate = response.headers.get("www-authenticate")
        ?? response.headers.get("WWW-Authenticate");
      const challenge = parseWwwAuthenticate(wwwAuthenticate);
      const detail = challenge?.errorDescription
        ?? challenge?.errorCode
        ?? `HTTP ${response.status} from MCP server.`;
      return {
        status: "needs_auth",
        toolCount: null,
        authChallenge: challenge,
        detail,
        checkedAt,
        httpStatus: response.status,
      };
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return {
        status: "error",
        toolCount: null,
        authChallenge: null,
        detail: `tools/list returned HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
        checkedAt,
        httpStatus: response.status,
      };
    }

    const toolCount = await parseToolsListResponse(response);
    if (toolCount === null) {
      return {
        status: "error",
        toolCount: null,
        authChallenge: null,
        detail: "tools/list returned a response that did not contain a tool list.",
        checkedAt,
        httpStatus: response.status,
      };
    }

    return {
      status: "connected",
      toolCount,
      authChallenge: null,
      detail: `Connected. ${toolCount} tool${toolCount === 1 ? "" : "s"} available.`,
      checkedAt,
      httpStatus: response.status,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "tools/list request failed.";
    return {
      status: "error",
      toolCount: null,
      authChallenge: null,
      detail: message,
      checkedAt,
      httpStatus: null,
    };
  } finally {
    clearTimeout(timer);
  }
}
