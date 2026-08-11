import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deleteMcpServerSecret } from "@/lib/mcp-secrets";
import { resolveOpenClawStateDir } from "@/lib/workspace";

type UnknownRecord = Record<string, unknown>;

export type McpServerConfig = {
  url: string;
  transport: string;
  headers?: Record<string, string>;
};

/**
 * Lifecycle of a user-added MCP server in the settings UI:
 *
 *   untested    : just added, never probed
 *   connected   : probe succeeded, tools are reachable
 *   needs_auth  : probe returned 401/403; user must click Connect
 *   error       : probe failed for non-auth reasons (network, malformed)
 */
export type McpServerState = "untested" | "connected" | "needs_auth" | "error";

export type McpServerEntry = {
  key: string;
  url: string;
  transport: string;
  hasAuth: boolean;
  state: McpServerState;
  toolCount: number | null;
  lastCheckedAt: string | null;
  lastDetail: string | null;
};

export class McpServerError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "McpServerError";
    this.status = status;
  }
}

const MCP_SERVER_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;
const REMOTE_MCP_TRANSPORT = "streamable-http";
const STATE_SIDECAR_FILENAME = ".mcp-states.json";

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function openClawConfigPath(): string {
  return join(resolveOpenClawStateDir(), "openclaw.json");
}

function statesSidecarPath(): string {
  return join(resolveOpenClawStateDir(), STATE_SIDECAR_FILENAME);
}

function readConfig(): UnknownRecord {
  const configPath = openClawConfigPath();
  if (!existsSync(configPath)) {
    return {};
  }
  try {
    return (JSON.parse(readFileSync(configPath, "utf-8")) as UnknownRecord) ?? {};
  } catch {
    return {};
  }
}

function ensureStateDir(): void {
  const stateDir = resolveOpenClawStateDir();
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }
}

function writeConfig(config: UnknownRecord): void {
  ensureStateDir();
  writeFileSync(openClawConfigPath(), JSON.stringify(config, null, 2) + "\n", "utf-8");
}

type StateRecord = {
  state: McpServerState;
  toolCount: number | null;
  lastCheckedAt: string | null;
  lastDetail: string | null;
};

function readStatesSidecar(): Record<string, StateRecord> {
  const path = statesSidecarPath();
  if (!existsSync(path)) {
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    const record = asRecord(parsed);
    if (!record) {
      return {};
    }
    const out: Record<string, StateRecord> = {};
    for (const [key, value] of Object.entries(record)) {
      const entry = asRecord(value);
      if (!entry) {
        continue;
      }
      const state = readString(entry.state);
      out[key] = {
        state: isMcpServerState(state) ? state : "untested",
        toolCount: typeof entry.toolCount === "number" ? entry.toolCount : null,
        lastCheckedAt: readString(entry.lastCheckedAt) ?? null,
        lastDetail: readString(entry.lastDetail) ?? null,
      };
    }
    return out;
  } catch {
    return {};
  }
}

function writeStatesSidecar(states: Record<string, StateRecord>): void {
  ensureStateDir();
  writeFileSync(
    statesSidecarPath(),
    JSON.stringify(states, null, 2) + "\n",
    "utf-8",
  );
}

function isMcpServerState(value: string | undefined): value is McpServerState {
  return value === "untested"
    || value === "connected"
    || value === "needs_auth"
    || value === "error";
}

function ensureRecord(parent: UnknownRecord, key: string): UnknownRecord {
  const existing = asRecord(parent[key]);
  if (existing) {
    return existing;
  }
  const fresh: UnknownRecord = {};
  parent[key] = fresh;
  return fresh;
}

function assertServerKey(key: string): string {
  const normalizedKey = key.trim();
  if (!normalizedKey) {
    throw new McpServerError(400, "Field 'key' is required.");
  }
  if (!MCP_SERVER_KEY_PATTERN.test(normalizedKey)) {
    throw new McpServerError(
      400,
      "Field 'key' must use only letters, numbers, hyphens, or underscores.",
    );
  }
  return normalizedKey;
}

function normalizeTransport(transport?: string): string {
  const normalizedTransport = transport?.trim() || REMOTE_MCP_TRANSPORT;
  if (normalizedTransport !== REMOTE_MCP_TRANSPORT) {
    throw new McpServerError(
      400,
      `Only '${REMOTE_MCP_TRANSPORT}' transport is supported in Cloud settings.`,
    );
  }
  return normalizedTransport;
}

function normalizeUrl(url: string): string {
  const normalizedUrl = url.trim();
  if (!normalizedUrl) {
    throw new McpServerError(400, "Field 'url' is required.");
  }

  let parsed: URL;
  try {
    parsed = new URL(normalizedUrl);
  } catch {
    throw new McpServerError(400, "Field 'url' must be a valid HTTP or HTTPS URL.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new McpServerError(400, "Field 'url' must use the http or https protocol.");
  }

  return parsed.toString();
}

function formatAuthorizationHeader(authToken?: string | null): string | null {
  const normalizedToken = authToken?.trim();
  if (!normalizedToken) {
    return null;
  }
  const tokenWithoutPrefix = normalizedToken.replace(/^Bearer\s+/iu, "").trim();
  if (!tokenWithoutPrefix) {
    throw new McpServerError(400, "Field 'authToken' must not be empty.");
  }
  return `Bearer ${tokenWithoutPrefix}`;
}

function defaultStateRecord(): StateRecord {
  return {
    state: "untested",
    toolCount: null,
    lastCheckedAt: null,
    lastDetail: null,
  };
}

function buildEntry(
  key: string,
  rawServer: UnknownRecord,
  states: Record<string, StateRecord>,
): McpServerEntry | null {
  const url = readString(rawServer.url);
  const transport = readString(rawServer.transport);
  if (!url || !transport) {
    return null;
  }

  const headers = asRecord(rawServer.headers);
  const stateRecord = states[key] ?? defaultStateRecord();
  return {
    key,
    url,
    transport,
    hasAuth: Boolean(readString(headers?.Authorization)),
    state: stateRecord.state,
    toolCount: stateRecord.toolCount,
    lastCheckedAt: stateRecord.lastCheckedAt,
    lastDetail: stateRecord.lastDetail,
  };
}

export function listMcpServers(): McpServerEntry[] {
  const config = readConfig();
  const mcp = asRecord(config.mcp);
  const servers = asRecord(mcp?.servers);
  if (!servers) {
    return [];
  }

  const states = readStatesSidecar();

  return Object.entries(servers)
    .map(([key, rawServer]) => {
      const server = asRecord(rawServer);
      return server ? buildEntry(key, server, states) : null;
    })
    .filter((server): server is McpServerEntry => Boolean(server))
    .toSorted((a, b) => a.key.localeCompare(b.key));
}

export function getMcpServer(key: string): McpServerEntry | null {
  const normalizedKey = assertServerKey(key);
  const config = readConfig();
  const mcp = asRecord(config.mcp);
  const servers = asRecord(mcp?.servers);
  const raw = asRecord(servers?.[normalizedKey]);
  if (!raw) {
    return null;
  }
  return buildEntry(normalizedKey, raw, readStatesSidecar());
}

/**
 * Returns the wire-level config (url, transport, headers) for the given
 * server, or null if the server doesn't exist. Used by the probe and
 * connect-token routes that need to make outbound requests on behalf of
 * the user.
 */
export function getMcpServerConfig(key: string): McpServerConfig | null {
  const normalizedKey = assertServerKey(key);
  const config = readConfig();
  const mcp = asRecord(config.mcp);
  const servers = asRecord(mcp?.servers);
  const raw = asRecord(servers?.[normalizedKey]);
  if (!raw) {
    return null;
  }
  const url = readString(raw.url);
  const transport = readString(raw.transport);
  if (!url || !transport) {
    return null;
  }
  const headersRaw = asRecord(raw.headers);
  const headers: Record<string, string> = {};
  if (headersRaw) {
    for (const [hKey, hValue] of Object.entries(headersRaw)) {
      const stringValue = readString(hValue);
      if (stringValue) {
        headers[hKey] = stringValue;
      }
    }
  }
  return {
    url,
    transport,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
}

export function addMcpServer(input: {
  key: string;
  url: string;
  transport?: string;
  authToken?: string | null;
}): McpServerEntry {
  const key = assertServerKey(input.key);
  const url = normalizeUrl(input.url);
  const transport = normalizeTransport(input.transport);
  const authorizationHeader = formatAuthorizationHeader(input.authToken);

  const config = readConfig();
  const mcp = ensureRecord(config, "mcp");
  const servers = ensureRecord(mcp, "servers");

  if (asRecord(servers[key])) {
    throw new McpServerError(409, `MCP server '${key}' already exists.`);
  }

  const nextServer: McpServerConfig = {
    url,
    transport,
    ...(authorizationHeader
      ? { headers: { Authorization: authorizationHeader } }
      : {}),
  };
  servers[key] = nextServer;

  writeConfig(config);

  // New servers start untested — the caller is expected to probe immediately
  // afterward and the result will overwrite this default.
  const states = readStatesSidecar();
  states[key] = defaultStateRecord();
  writeStatesSidecar(states);

  return {
    key,
    url,
    transport,
    hasAuth: Boolean(authorizationHeader),
    state: "untested",
    toolCount: null,
    lastCheckedAt: null,
    lastDetail: null,
  };
}

/**
 * Replace the `Authorization` header on an existing server. Pass `null` to
 * clear it (e.g. after a disconnect or token revocation).
 *
 * Used by the Connect flow's token route (Phase 1) and the OAuth callback
 * route (Phase 2) — both ultimately end up writing a Bearer header here.
 */
export function setAuthorizationHeader(
  key: string,
  header: string | null,
): McpServerEntry {
  const normalizedKey = assertServerKey(key);
  const config = readConfig();
  const mcp = asRecord(config.mcp);
  const servers = asRecord(mcp?.servers);
  const existing = asRecord(servers?.[normalizedKey]);
  if (!servers || !existing) {
    throw new McpServerError(404, `MCP server '${normalizedKey}' was not found.`);
  }

  const headers = asRecord(existing.headers) ?? {};
  if (header === null) {
    delete headers.Authorization;
    if (Object.keys(headers).length === 0) {
      delete existing.headers;
    } else {
      existing.headers = headers;
    }
  } else {
    headers.Authorization = header;
    existing.headers = headers;
  }

  writeConfig(config);

  const entry = buildEntry(normalizedKey, existing, readStatesSidecar());
  if (!entry) {
    throw new McpServerError(500, "Failed to read server entry after update.");
  }
  return entry;
}

/**
 * Persist the result of a probe (or any other state change) for a given
 * server. Stored in a sidecar file so we don't pollute the wire-level
 * `mcp.servers.<key>` config that the agent runtime consumes.
 */
export function recordServerState(
  key: string,
  update: {
    state: McpServerState;
    toolCount?: number | null;
    detail?: string | null;
    checkedAt?: string;
  },
): McpServerEntry {
  const normalizedKey = assertServerKey(key);
  const config = readConfig();
  const mcp = asRecord(config.mcp);
  const servers = asRecord(mcp?.servers);
  const existing = asRecord(servers?.[normalizedKey]);
  if (!existing) {
    throw new McpServerError(404, `MCP server '${normalizedKey}' was not found.`);
  }

  const states = readStatesSidecar();
  states[normalizedKey] = {
    state: update.state,
    toolCount: update.toolCount ?? null,
    lastCheckedAt: update.checkedAt ?? new Date().toISOString(),
    lastDetail: update.detail ?? null,
  };
  writeStatesSidecar(states);

  const entry = buildEntry(normalizedKey, existing, states);
  if (!entry) {
    throw new McpServerError(500, "Failed to read server entry after state update.");
  }
  return entry;
}

export function removeMcpServer(key: string): void {
  const normalizedKey = assertServerKey(key);
  const config = readConfig();
  const mcp = asRecord(config.mcp);
  const servers = asRecord(mcp?.servers);

  if (!servers || !asRecord(servers[normalizedKey])) {
    throw new McpServerError(404, `MCP server '${normalizedKey}' was not found.`);
  }

  delete servers[normalizedKey];

  if (Object.keys(servers).length === 0 && mcp) {
    delete mcp.servers;
  }
  if (mcp && Object.keys(mcp).length === 0) {
    delete config.mcp;
  }

  writeConfig(config);

  const states = readStatesSidecar();
  if (states[normalizedKey]) {
    delete states[normalizedKey];
    writeStatesSidecar(states);
  }
  deleteMcpServerSecret(normalizedKey);
}
