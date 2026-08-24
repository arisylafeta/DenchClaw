import { beforeEach, describe, expect, it } from "vitest";
import {
  authorizeTerminalProtocolHeader,
  clearTerminalAccessTokens,
  issueTerminalAccessToken,
  selectTerminalAccessProtocol,
} from "./terminal-access";
import { buildTerminalAccessProtocol } from "./terminal-connection";

describe("terminal WebSocket access", () => {
  beforeEach(() => clearTerminalAccessTokens());

  it("accepts an API-issued protocol token exactly once", () => {
    const token = issueTerminalAccessToken(1_000);
    const protocol = buildTerminalAccessProtocol(token);

    expect(authorizeTerminalProtocolHeader(protocol, 1_001)).toBe(true);
    expect(authorizeTerminalProtocolHeader(protocol, 1_002)).toBe(false);
  });

  it("rejects missing, unknown, and expired tokens", () => {
    expect(authorizeTerminalProtocolHeader(undefined, 1_000)).toBe(false);
    expect(authorizeTerminalProtocolHeader("dench-terminal.unknown", 1_000)).toBe(false);

    const token = issueTerminalAccessToken(1_000);
    expect(
      authorizeTerminalProtocolHeader(buildTerminalAccessProtocol(token), 31_000),
    ).toBe(false);
  });

  it("echoes only the terminal access subprotocol", () => {
    expect(
      selectTerminalAccessProtocol(new Set(["other", "dench-terminal.token"])),
    ).toBe("dench-terminal.token");
    expect(selectTerminalAccessProtocol(new Set(["other"]))).toBe(false);
  });
});
