import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { validateSessionTokenMock } = vi.hoisted(() => ({
  validateSessionTokenMock: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  validateSessionToken: validateSessionTokenMock,
}));

import { middleware } from "../middleware";

function request(
  path: string,
  options: { method?: string; origin?: string; token?: string } = {},
) {
  const headers = new Headers();
  if (options.origin) headers.set("origin", options.origin);
  if (options.token)
    headers.set("cookie", `denchclaw_session=${options.token}`);
  return new NextRequest(`https://crm.rebattery.io${path}`, {
    method: options.method ?? "GET",
    headers,
  });
}

describe("CRM auth middleware", () => {
  beforeEach(() => validateSessionTokenMock.mockReset());

  it.each([
    "/login",
    "/api/auth/login",
    "/api/auth/me",
    "/api/composio/callback",
    "/api/settings/mcp/connect/callback",
    "/api/apps/webhooks/example",
    "/rebattery-favicon.svg",
    "/rebattery-workspace-icon.svg",
  ])("allows the explicit public path %s", async (path) => {
    const response = await middleware(request(path));
    expect(response.status).toBe(200);
    expect(validateSessionTokenMock).not.toHaveBeenCalled();
  });

  it("does not broaden webhook or login exceptions to lookalike paths", async () => {
    const webhook = await middleware(request("/api/apps/webhooks-evil"));
    const login = await middleware(request("/login-copy"));
    expect(webhook.status).toBe(401);
    expect(login.status).toBe(307);
  });

  it("redirects an unauthenticated UI request and preserves only its pathname", async () => {
    const response = await middleware(request("/workspace?secret=value"));
    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe("/workspace");
    expect(location.search).not.toContain("secret");
  });

  it("returns 401 for missing, forged, malformed, expired, or revoked API sessions", async () => {
    validateSessionTokenMock.mockResolvedValue(null);
    for (const token of [
      undefined,
      "malformed",
      "forged-token",
      "expired-token",
      "revoked-token",
    ]) {
      const response = await middleware(
        request("/api/workspace/tree", { token }),
      );
      expect(response.status).toBe(401);
    }
  });

  it("allows a protected request only after authoritative session validation", async () => {
    validateSessionTokenMock.mockResolvedValue({
      id: "user-1",
      email: "ari@rebattery.io",
      displayName: "Ari",
    });
    const response = await middleware(
      request("/api/workspace/tree", { token: "x".repeat(43) }),
    );
    expect(response.status).toBe(200);
    expect(validateSessionTokenMock).toHaveBeenCalledWith("x".repeat(43));
  });

  it("rejects protected mutations with a missing or cross-origin Origin", async () => {
    validateSessionTokenMock.mockResolvedValue({ id: "user-1" });
    const missing = await middleware(
      request("/api/workspace/file", { method: "POST", token: "x".repeat(43) }),
    );
    const crossOrigin = await middleware(
      request("/api/workspace/file", {
        method: "POST",
        origin: "https://evil.example",
        token: "x".repeat(43),
      }),
    );
    expect(missing.status).toBe(403);
    expect(crossOrigin.status).toBe(403);
  });

  it("allows same-origin protected mutations and protects logout", async () => {
    validateSessionTokenMock.mockResolvedValue({ id: "user-1" });
    const mutation = await middleware(
      request("/api/workspace/file", {
        method: "POST",
        origin: "https://crm.rebattery.io",
        token: "x".repeat(43),
      }),
    );
    const logout = await middleware(
      request("/api/auth/logout", {
        method: "POST",
        origin: "https://crm.rebattery.io",
        token: "x".repeat(43),
      }),
    );
    expect(mutation.status).toBe(200);
    expect(logout.status).toBe(200);
  });
});
