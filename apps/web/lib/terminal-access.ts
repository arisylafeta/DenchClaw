import { randomBytes } from "node:crypto";
import { TERMINAL_ACCESS_PROTOCOL_PREFIX } from "./terminal-connection";

const TERMINAL_ACCESS_TTL_MS = 30_000;

const globalState = globalThis as unknown as {
  __terminalAccessTokens?: Map<string, number>;
};

const accessTokens = globalState.__terminalAccessTokens ?? new Map<string, number>();
globalState.__terminalAccessTokens = accessTokens;

function discardExpiredTokens(now: number): void {
  for (const [token, expiresAt] of accessTokens) {
    if (expiresAt <= now) accessTokens.delete(token);
  }
}

export function issueTerminalAccessToken(now = Date.now()): string {
  discardExpiredTokens(now);
  const token = randomBytes(32).toString("base64url");
  accessTokens.set(token, now + TERMINAL_ACCESS_TTL_MS);
  return token;
}

export function authorizeTerminalProtocolHeader(
  header: string | string[] | undefined,
  now = Date.now(),
): boolean {
  const offered = Array.isArray(header) ? header.join(",") : header;
  const protocol = offered
    ?.split(",")
    .map((value) => value.trim())
    .find((value) => value.startsWith(TERMINAL_ACCESS_PROTOCOL_PREFIX));
  if (!protocol) return false;

  const token = protocol.slice(TERMINAL_ACCESS_PROTOCOL_PREFIX.length);
  const expiresAt = accessTokens.get(token);
  accessTokens.delete(token);
  return expiresAt !== undefined && expiresAt > now;
}

export function selectTerminalAccessProtocol(
  protocols: ReadonlySet<string>,
): string | false {
  return Array.from(protocols).find((protocol) =>
    protocol.startsWith(TERMINAL_ACCESS_PROTOCOL_PREFIX)
  ) ?? false;
}

export function clearTerminalAccessTokens(): void {
  accessTokens.clear();
}
