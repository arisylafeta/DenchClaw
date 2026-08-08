import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const {
  fetchComposioConnectionsMock,
  initiateComposioConnectMock,
  resolveComposioApiKeyMock,
  resolveComposioEligibilityMock,
  resolveComposioGatewayUrlMock,
  readOnboardingStateMock,
  writeConnectionMock,
  writeOnboardingStateMock,
} = vi.hoisted(() => ({
  fetchComposioConnectionsMock: vi.fn(),
  initiateComposioConnectMock: vi.fn(),
  resolveComposioApiKeyMock: vi.fn(),
  resolveComposioEligibilityMock: vi.fn(),
  resolveComposioGatewayUrlMock: vi.fn(),
  readOnboardingStateMock: vi.fn(),
  writeConnectionMock: vi.fn(),
  writeOnboardingStateMock: vi.fn(),
}));

vi.mock("@/lib/composio", () => ({
  fetchComposioConnections: fetchComposioConnectionsMock,
  initiateComposioConnect: initiateComposioConnectMock,
  resolveComposioApiKey: resolveComposioApiKeyMock,
  resolveComposioEligibility: resolveComposioEligibilityMock,
  resolveComposioGatewayUrl: resolveComposioGatewayUrlMock,
}));

vi.mock("@/lib/denchclaw-state", () => ({
  readOnboardingState: readOnboardingStateMock,
  writeConnection: writeConnectionMock,
  writeOnboardingState: writeOnboardingStateMock,
}));

const ORIGINAL_PUBLIC_URL = process.env.DENCHCLAW_PUBLIC_URL;

describe("Composio connect API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.DENCHCLAW_PUBLIC_URL;
    resolveComposioApiKeyMock.mockReturnValue("dench_test_key");
    resolveComposioEligibilityMock.mockReturnValue({
      eligible: true,
      lockReason: null,
      lockBadge: null,
    });
    resolveComposioGatewayUrlMock.mockReturnValue("https://gateway.example.com");
    fetchComposioConnectionsMock.mockResolvedValue({ connections: [] });
    initiateComposioConnectMock.mockResolvedValue({
      redirect_url: "https://composio.example/connect/zoho",
    });
    readOnboardingStateMock.mockReturnValue({
      version: 1,
      currentStep: "connect-gmail",
      completedSteps: ["welcome", "identity", "dench-cloud"],
      startedAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
    });
  });

  afterEach(() => {
    if (ORIGINAL_PUBLIC_URL === undefined) {
      delete process.env.DENCHCLAW_PUBLIC_URL;
    } else {
      process.env.DENCHCLAW_PUBLIC_URL = ORIGINAL_PUBLIC_URL;
    }
  });

  it("passes the selected toolkit slug and callback URL through to the gateway connect call", async () => {
    const response = await POST(
      new Request("http://localhost/api/composio/connect", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          toolkit: "zoho",
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(initiateComposioConnectMock).toHaveBeenCalledWith(
      "https://gateway.example.com",
      "dench_test_key",
      "zoho",
      "http://localhost/api/composio/callback",
    );
    expect(await response.json()).toEqual({
      redirect_url: "https://composio.example/connect/zoho",
      requested_toolkit: "zoho",
      connect_toolkit: "zoho",
    });
  });

  it("uses DENCHCLAW_PUBLIC_URL for the callback origin when set (ReBattery Cloud sandbox)", async () => {
    process.env.DENCHCLAW_PUBLIC_URL =
      "https://dench-com.sandbox.merseoriginals.com";

    const response = await POST(
      new Request("http://localhost/api/composio/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ toolkit: "zoho" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(initiateComposioConnectMock).toHaveBeenCalledWith(
      "https://gateway.example.com",
      "dench_test_key",
      "zoho",
      "https://dench-com.sandbox.merseoriginals.com/api/composio/callback",
    );
  });

  it("prefers X-Forwarded-* headers over DENCHCLAW_PUBLIC_URL — needed for warm-pool rebinds where the running container has a stale env value", async () => {
    process.env.DENCHCLAW_PUBLIC_URL =
      "https://stale-warm-pool-slug.sandbox.merseoriginals.com";

    const response = await POST(
      new Request("http://localhost/api/composio/connect", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-host": "real-org.sandbox.merseoriginals.com",
          "x-forwarded-proto": "https",
        },
        body: JSON.stringify({ toolkit: "zoho" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(initiateComposioConnectMock).toHaveBeenCalledWith(
      "https://gateway.example.com",
      "dench_test_key",
      "zoho",
      "https://real-org.sandbox.merseoriginals.com/api/composio/callback",
    );
  });

  it("returns the existing active connection for the same app", async () => {
    fetchComposioConnectionsMock.mockResolvedValue({
      connections: [
        {
          id: "ca_gmail_1",
          toolkit_slug: "gmail",
          toolkit_name: "Gmail",
          status: "ACTIVE",
          created_at: "2026-04-01T00:00:00.000Z",
          account_email: "person@example.com",
        },
      ],
    });

    const response = await POST(
      new Request("http://localhost/api/composio/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ toolkit: "gmail" }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      already_connected: true,
      connection_id: "ca_gmail_1",
      connected_account_id: "ca_gmail_1",
      toolkit: "gmail",
      connected_toolkit_slug: "gmail",
      connected_toolkit_name: "Gmail",
      account_email: "person@example.com",
    });
    expect(initiateComposioConnectMock).not.toHaveBeenCalled();
    expect(writeConnectionMock).toHaveBeenCalledWith(
      "gmail",
      expect.objectContaining({
        connectionId: "ca_gmail_1",
        toolkitSlug: "gmail",
        accountEmail: "person@example.com",
      }),
    );
    expect(writeOnboardingStateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        connections: expect.objectContaining({
          gmail: expect.objectContaining({
            connectionId: "ca_gmail_1",
          }),
        }),
      }),
    );
  });

  it("returns an existing Google Calendar connection for connect slug aliases", async () => {
    fetchComposioConnectionsMock.mockResolvedValue({
      connections: [
        {
          id: "ca_calendar_1",
          toolkit_slug: "google-calendar",
          toolkit_name: "Google Calendar",
          status: "ACTIVE",
          created_at: "2026-04-01T00:00:00.000Z",
        },
      ],
    });

    const response = await POST(
      new Request("http://localhost/api/composio/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ toolkit: "googlecalendar" }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      already_connected: true,
      connection_id: "ca_calendar_1",
      connected_account_id: "ca_calendar_1",
      toolkit: "google-calendar",
      connected_toolkit_slug: "google-calendar",
    });
    expect(initiateComposioConnectMock).not.toHaveBeenCalled();
  });
});
