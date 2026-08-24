export type TerminalConnectionLocation = {
  protocol: string;
  hostname: string;
  host: string;
};

export const TERMINAL_ACCESS_PROTOCOL_PREFIX = "dench-terminal.";

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost"
    || normalized === "::1"
    || normalized === "0.0.0.0"
    || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

export function buildTerminalAccessProtocol(accessToken: string): string {
  return `${TERMINAL_ACCESS_PROTOCOL_PREFIX}${accessToken}`;
}

export function buildTerminalWebSocketUrl(
  location: TerminalConnectionLocation,
  port: number,
  useProxy: boolean,
): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return useProxy || !isLoopbackHostname(location.hostname)
    ? `${protocol}//${location.host}/terminal-ws/`
    : `${protocol}//127.0.0.1:${port}`;
}
