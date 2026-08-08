import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

let stateDir = "";

vi.mock("@/lib/workspace", () => ({
  resolveOpenClawStateDir: vi.fn(() => stateDir),
}));

const {
  disconnectComposioApp,
  fetchComposioMcpToolsList,
  resolveComposioGatewayUrl,
} = await import("./composio");

describe("composio config resolution", () => {
  beforeEach(() => {
    stateDir = path.join(os.tmpdir(), `dench-composio-state-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("prefers the ReBattery Cloud provider baseUrl when resolving the Composio gateway URL", () => {
    writeFileSync(
      path.join(stateDir, "openclaw.json"),
      JSON.stringify({
        models: {
          providers: {
            "dench-cloud": {
              baseUrl: "https://gateway.example.com/v1",
            },
          },
        },
        plugins: {
          entries: {
            "dench-ai-gateway": {
              config: {
                gatewayUrl: "https://stale-plugin.example.com",
              },
            },
          },
        },
      }),
      "utf-8",
    );

    expect(resolveComposioGatewayUrl()).toBe("https://gateway.example.com");
  });

  it("passes connected toolkit and preferred tool hints to the gateway tools/list probe", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        result: {
          tools: [],
        },
      })),
    );

    await fetchComposioMcpToolsList(
      "https://gateway.example.com",
      "dench_test_key",
      {
        connectedToolkits: ["gmail", "slack"],
        preferredToolNames: ["GMAIL_FETCH_EMAILS", "SLACK_SEND_MESSAGE"],
      },
    );

    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse(String(init?.body)) as {
      params: {
        connected_toolkits: string[];
        preferred_tool_names: string[];
      };
    };

    expect(body.params.connected_toolkits).toEqual(["gmail", "slack"]);
    expect(body.params.preferred_tool_names).toEqual([
      "GMAIL_FETCH_EMAILS",
      "SLACK_SEND_MESSAGE",
    ]);
  });
});

/**
 * `disconnectComposioApp` contract — pinned because the original code
 * threw on every non-2xx including 404, which surfaced as a confusing
 * "Failed to disconnect (HTTP 404)" toast when the user clicked
 * Disconnect on a stale row whose Composio account had already been
 * revoked upstream (the screenshot bug). The fix: 404 is success
 * with `alreadyGone: true`, anything else still throws.
 */
describe("disconnectComposioApp", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns deleted: true on a successful 200 with JSON body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ deleted: true }), { status: 200 }),
    );
    const result = await disconnectComposioApp("https://gw.example.com", "key", "ca_xxx");
    expect(result).toEqual({ deleted: true });
  });

  it("returns deleted: true with no body when Composio returns an empty 200", async () => {
    // Real REST DELETE responses often have no body; we shouldn't
    // surface "Unexpected end of JSON input" in that case. Note: we
    // can't model 204 here because the WHATWG Response constructor
    // refuses to pair a body with 204 (per spec) — 200 with empty
    // body covers the same code path inside `disconnectComposioApp`.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", { status: 200 }),
    );
    const result = await disconnectComposioApp("https://gw.example.com", "key", "ca_xxx");
    expect(result).toEqual({ deleted: true });
  });

  it("treats HTTP 404 as already-gone success (the screenshot bug)", async () => {
    // The exact body Composio returns for a connection that no longer
    // exists upstream. Without the 404 special case, this would throw
    // and the user sees "Failed to disconnect (HTTP 404)".
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            message: "Connected account not found",
            type: "invalid_request_error",
            code: "composio_client_error",
          },
        }),
        { status: 404 },
      ),
    );
    const result = await disconnectComposioApp("https://gw.example.com", "key", "ca_dead");
    expect(result).toEqual({ deleted: true, alreadyGone: true });
  });

  it("throws on non-2xx, non-404 errors so transient failures aren't masked", async () => {
    // 502 = real gateway problem. We must throw so the route surfaces
    // a 502 to the client and the modal keeps the row in the list.
    // Treating 5xx as alreadyGone would silently delete entries the
    // user actually wanted to keep.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("bad gateway", { status: 502 }),
    );
    await expect(
      disconnectComposioApp("https://gw.example.com", "key", "ca_xxx"),
    ).rejects.toThrow(/Failed to disconnect.*502/);
  });

  it("hits the right URL with DELETE + Bearer auth", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ deleted: true }), { status: 200 }),
    );
    await disconnectComposioApp("https://gw.example.com", "secret_key", "ca_abc");
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://gw.example.com/v1/composio/connections/ca_abc");
    expect(init?.method).toBe("DELETE");
    const headers = new Headers(init?.headers as HeadersInit);
    expect(headers.get("authorization")).toBe("Bearer secret_key");
  });

  it("URL-encodes weird connection ids defensively", async () => {
    // Composio ids are usually slug-safe, but we encode anyway so a
    // future id format with `/` or `%` doesn't punch through to a
    // different gateway path.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ deleted: true }), { status: 200 }),
    );
    await disconnectComposioApp("https://gw.example.com", "k", "ca/with weird?chars");
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe(
      "https://gw.example.com/v1/composio/connections/ca%2Fwith%20weird%3Fchars",
    );
  });
});
