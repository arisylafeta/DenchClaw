import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { refreshSessionTokenMock } = vi.hoisted(() => ({
  refreshSessionTokenMock: vi.fn(),
}));
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  refreshSessionToken: refreshSessionTokenMock,
}));

import { middleware } from "../middleware";

function request(
  path: string,
  options: {
    method?: string;
    origin?: string;
    token?: string;
    forwardedHost?: string;
    forwardedProto?: string;
    requestBase?: string;
  } = {},
) {
  const headers = new Headers();
  if (options.origin) headers.set("origin", options.origin);
  if (options.token)
    headers.set("cookie", `denchclaw_session=${options.token}`);
  if (options.forwardedHost)
    headers.set("x-forwarded-host", options.forwardedHost);
  if (options.forwardedProto)
    headers.set("x-forwarded-proto", options.forwardedProto);
  return new NextRequest(
    `${options.requestBase ?? "https://crm.rebattery.io"}${path}`,
    {
      method: options.method ?? "GET",
      headers,
    },
  );
}

describe("CRM auth middleware", () => {
  beforeEach(() => {
    refreshSessionTokenMock.mockReset();
  });

  it.each([
    "/login",
    "/api/auth/login",
    "/api/settings/mcp/connect/callback",
    "/api/apps/webhooks/example",
    "/rebattery-favicon.svg",
    "/rebattery-logo-all-black.svg",
    "/rebattery-workspace-icon.svg",
  ])("allows the explicit public path %s", async (path) => {
    const response = await middleware(request(path));
    expect(response.status).toBe(200);
    expect(refreshSessionTokenMock).not.toHaveBeenCalled();
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

  it("redirects to the validated public reverse-proxy origin", async () => {
    const response = await middleware(
      request("/workspace", {
        forwardedHost: "crm.rebattery.io",
        forwardedProto: "https",
        requestBase: "http://localhost:3100",
      }),
    );
    expect(response.headers.get("location")).toBe(
      "https://crm.rebattery.io/login?next=%2Fworkspace",
    );
  });

  it("returns 401 for missing, forged, malformed, expired, or revoked API sessions", async () => {
    refreshSessionTokenMock.mockResolvedValue(null);
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

  it("renews a valid session for 30 days at the authenticated request boundary", async () => {
    refreshSessionTokenMock.mockResolvedValue({
      id: "user-1",
      email: "ari@rebattery.io",
      displayName: "Ari",
    });
    const response = await middleware(
      request("/api/auth/me", { token: "x".repeat(43) }),
    );
    expect(response.status).toBe(200);
    expect(refreshSessionTokenMock).toHaveBeenCalledWith("x".repeat(43));
    expect(response.headers.get("set-cookie")).toContain("Max-Age=2592000");
  });

  it("rejects protected mutations with a missing or cross-origin Origin", async () => {
    refreshSessionTokenMock.mockResolvedValue({ id: "user-1" });
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
    expect(refreshSessionTokenMock).not.toHaveBeenCalled();
  });

  it("lets same-origin logout clear missing or stale cookies without renewal", async () => {
    const missing = await middleware(
      request("/api/auth/logout", {
        method: "POST",
        origin: "https://crm.rebattery.io",
      }),
    );
    const stale = await middleware(
      request("/api/auth/logout", {
        method: "POST",
        origin: "https://crm.rebattery.io",
        token: "expired-token",
      }),
    );
    expect(missing.status).toBe(200);
    expect(stale.status).toBe(200);
    expect(refreshSessionTokenMock).not.toHaveBeenCalled();
  });

  it("allows same-origin protected mutations and protects logout", async () => {
    refreshSessionTokenMock.mockResolvedValue({ id: "user-1" });
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
    expect(logout.headers.get("set-cookie")).toBeNull();
    expect(refreshSessionTokenMock).toHaveBeenCalledTimes(1);
  });
});
