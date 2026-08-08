import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/composio", () => ({
  disconnectComposioApp: vi.fn(),
  resolveComposioApiKey: vi.fn(),
  resolveComposioEligibility: vi.fn(),
  resolveComposioGatewayUrl: vi.fn(),
}));

vi.mock("@/lib/integrations", () => ({
  refreshIntegrationsRuntime: vi.fn(),
}));

vi.mock("@/lib/denchclaw-state", () => ({
  readConnections: vi.fn(),
  clearConnection: vi.fn(),
}));

const { POST } = await import("./route");
const {
  disconnectComposioApp,
  resolveComposioApiKey,
  resolveComposioEligibility,
  resolveComposioGatewayUrl,
} = await import("@/lib/composio");
const { refreshIntegrationsRuntime } = await import("@/lib/integrations");
const { readConnections, clearConnection } = await import("@/lib/denchclaw-state");

const mockedDisconnectComposioApp = vi.mocked(disconnectComposioApp);
const mockedResolveComposioApiKey = vi.mocked(resolveComposioApiKey);
const mockedResolveComposioEligibility = vi.mocked(resolveComposioEligibility);
const mockedResolveComposioGatewayUrl = vi.mocked(resolveComposioGatewayUrl);
const mockedRefreshIntegrationsRuntime = vi.mocked(refreshIntegrationsRuntime);
const mockedReadConnections = vi.mocked(readConnections);
const mockedClearConnection = vi.mocked(clearConnection);

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/composio/disconnect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Composio disconnect API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedResolveComposioApiKey.mockReturnValue("dc-key");
    mockedResolveComposioEligibility.mockReturnValue({
      eligible: true,
      lockReason: null,
      lockBadge: null,
    });
    mockedResolveComposioGatewayUrl.mockReturnValue("https://gateway.merseoriginals.com");
    mockedDisconnectComposioApp.mockResolvedValue({ deleted: true });
    mockedRefreshIntegrationsRuntime.mockResolvedValue({
      attempted: true,
      restarted: true,
      error: null,
      profile: "dench",
    });
    mockedReadConnections.mockReturnValue({ version: 1, updatedAt: "2026-01-01T00:00:00.000Z" });
    mockedClearConnection.mockReturnValue({ version: 1, updatedAt: "2026-01-01T00:00:00.000Z" });
  });

  it("restarts the runtime after disconnecting", async () => {
    const response = await POST(makeRequest({ connection_id: "conn_123" }));

    const body = await response.json();
    expect(response.status).toBe(200);
    expect(mockedDisconnectComposioApp).toHaveBeenCalledWith(
      "https://gateway.merseoriginals.com",
      "dc-key",
      "conn_123",
    );
    expect(mockedRefreshIntegrationsRuntime).toHaveBeenCalledTimes(1);
    expect(body.runtime_refresh).toMatchObject({
      attempted: true,
      restarted: true,
      profile: "dench",
    });
  });

  it("clears the local connections.json record when the disconnected id matches gmail", async () => {
    // Without this, the sync runner keeps using the dead Composio id
    // every 5 minutes after disconnect — the SyncHealthBanner never
    // clears even though the user did the right thing.
    mockedReadConnections.mockReturnValue({
      version: 1,
      gmail: {
        connectionId: "conn_dead",
        toolkitSlug: "gmail",
        connectedAt: "2026-01-01T00:00:00.000Z",
      },
      calendar: {
        connectionId: "conn_other",
        toolkitSlug: "google-calendar",
        connectedAt: "2026-01-01T00:00:00.000Z",
      },
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const response = await POST(makeRequest({ connection_id: "conn_dead" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockedClearConnection).toHaveBeenCalledWith("gmail");
    expect(mockedClearConnection).not.toHaveBeenCalledWith("calendar");
    expect(body.local_cleanup).toEqual({ clearedGmail: true, clearedCalendar: false });
  });

  it("does not clear unrelated local records when disconnecting a different connection", async () => {
    // Disconnecting a no-longer-active Gmail account must NOT wipe the
    // currently-active Calendar entry from local state.
    mockedReadConnections.mockReturnValue({
      version: 1,
      gmail: {
        connectionId: "conn_active_gmail",
        toolkitSlug: "gmail",
        connectedAt: "2026-01-01T00:00:00.000Z",
      },
      calendar: {
        connectionId: "conn_active_cal",
        toolkitSlug: "google-calendar",
        connectedAt: "2026-01-01T00:00:00.000Z",
      },
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const response = await POST(makeRequest({ connection_id: "conn_unrelated" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockedClearConnection).not.toHaveBeenCalled();
    expect(body.local_cleanup).toEqual({ clearedGmail: false, clearedCalendar: false });
  });

  it("propagates alreadyGone from the lib through the response (HTTP 404 = success)", async () => {
    // The end-to-end story for the screenshot bug: Composio returned
    // 404 → lib turned it into success+alreadyGone → route returns 200
    // with the flag → modal shows "Disconnected" instead of an angry
    // red error toast.
    mockedDisconnectComposioApp.mockResolvedValueOnce({ deleted: true, alreadyGone: true });
    mockedReadConnections.mockReturnValue({
      version: 1,
      gmail: {
        connectionId: "ca_dead",
        toolkitSlug: "gmail",
        connectedAt: "2026-01-01T00:00:00.000Z",
      },
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const response = await POST(makeRequest({ connection_id: "ca_dead" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.deleted).toBe(true);
    expect(body.alreadyGone).toBe(true);
    // Local cleanup still runs for the now-dead id.
    expect(mockedClearConnection).toHaveBeenCalledWith("gmail");
  });

  it("returns 502 with the error message when the lib throws (transient gateway failure)", async () => {
    mockedDisconnectComposioApp.mockRejectedValueOnce(
      new Error("Failed to disconnect (HTTP 502)"),
    );
    const response = await POST(makeRequest({ connection_id: "conn_xxx" }));
    const body = await response.json();
    expect(response.status).toBe(502);
    expect(body.error).toMatch(/HTTP 502/);
    // Local cleanup MUST NOT run when the disconnect fails — otherwise
    // we'd be lying about what was deleted upstream.
    expect(mockedClearConnection).not.toHaveBeenCalled();
  });

  it("rejects requests without an api key (403)", async () => {
    mockedResolveComposioApiKey.mockReturnValue(null);
    const response = await POST(makeRequest({ connection_id: "conn_xxx" }));
    expect(response.status).toBe(403);
    expect(mockedDisconnectComposioApp).not.toHaveBeenCalled();
  });

  it("rejects ineligible ReBattery Cloud profile (403)", async () => {
    mockedResolveComposioEligibility.mockReturnValue({
      eligible: false,
      lockReason: "primary_provider_mismatch" as never,
      lockBadge: "external",
    });
    const response = await POST(makeRequest({ connection_id: "conn_xxx" }));
    expect(response.status).toBe(403);
    expect(mockedDisconnectComposioApp).not.toHaveBeenCalled();
  });

  it("rejects missing/empty connection_id (400)", async () => {
    const response = await POST(makeRequest({}));
    expect(response.status).toBe(400);
    const blank = await POST(makeRequest({ connection_id: "  " }));
    expect(blank.status).toBe(400);
    expect(mockedDisconnectComposioApp).not.toHaveBeenCalled();
  });
});
