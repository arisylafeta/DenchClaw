import { describe, expect, it } from "vitest";
import { buildTerminalWebSocketUrl } from "./terminal-connection";

describe("terminal WebSocket routing", () => {
  it("routes a remotely hosted workspace through its authenticated origin", () => {
    expect(
      buildTerminalWebSocketUrl(
        {
          protocol: "https:",
          hostname: "crm.rebattery.io",
          host: "crm.rebattery.io",
        },
        3101,
        false,
      ),
    ).toBe("wss://crm.rebattery.io/terminal-ws/");
  });

  it("keeps local workspaces on the loopback PTY port", () => {
    expect(
      buildTerminalWebSocketUrl(
        {
          protocol: "http:",
          hostname: "localhost",
          host: "localhost:3100",
        },
        3101,
        false,
      ),
    ).toBe("ws://127.0.0.1:3101");
  });

  it("honors an explicitly configured same-origin proxy on localhost", () => {
    expect(
      buildTerminalWebSocketUrl(
        {
          protocol: "http:",
          hostname: "localhost",
          host: "localhost:3100",
        },
        3101,
        true,
      ),
    ).toBe("ws://localhost:3100/terminal-ws/");
  });
});
