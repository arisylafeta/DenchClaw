import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

let stateDir = "";

vi.mock("@/lib/workspace", () => ({
  resolveOpenClawStateDir: vi.fn(() => stateDir),
}));

const {
  addMcpServer,
  removeMcpServer,
} = await import("./mcp-servers");
const {
  getMcpServerSecret,
  setMcpServerSecret,
} = await import("./mcp-secrets");

describe("mcp server config helpers", () => {
  beforeEach(() => {
    stateDir = path.join(os.tmpdir(), `dench-mcp-servers-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("deletes OAuth secrets when removing a server", () => {
    addMcpServer({
      key: "acme",
      url: "https://mcp.example.com",
    });
    setMcpServerSecret("acme", {
      clientId: "client-123",
      refreshToken: "refresh-123",
      asMetadataUrl: "https://mcp.example.com/.well-known/oauth-protected-resource",
      codeVerifier: "verifier-123",
      oauthState: "state-123",
    });

    removeMcpServer("acme");

    expect(getMcpServerSecret("acme")).toBeNull();
  });
});
