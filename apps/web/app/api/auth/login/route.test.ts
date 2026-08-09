import { beforeEach, describe, expect, it, vi } from "vitest";

const { loginMock, createSessionMock, sessionCookieMock } = vi.hoisted(() => ({
  loginMock: vi.fn(),
  createSessionMock: vi.fn(),
  sessionCookieMock: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  login: loginMock,
  createSession: createSessionMock,
  sessionCookie: sessionCookieMock,
}));

import { POST } from "./route";

function loginRequest(body: unknown, origin = "https://crm.rebattery.io") {
  return new Request("https://crm.rebattery.io/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body),
  });
}

describe("POST /api/auth/login", () => {
  beforeEach(() => {
    loginMock.mockReset();
    createSessionMock.mockReset();
    sessionCookieMock.mockReset();
  });

  it("rejects missing and cross-origin requests", async () => {
    const missing = new Request("https://crm.rebattery.io/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "ari@rebattery.io", password: "secret" }),
    });
    expect((await POST(missing)).status).toBe(403);
    expect((await POST(loginRequest({}, "https://evil.example"))).status).toBe(
      403,
    );
    expect(loginMock).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON and invalid field types", async () => {
    const malformed = new Request("https://crm.rebattery.io/api/auth/login", {
      method: "POST",
      headers: { origin: "https://crm.rebattery.io" },
      body: "{",
    });
    expect((await POST(malformed)).status).toBe(400);
    expect(
      (await POST(loginRequest({ email: 1, password: null }))).status,
    ).toBe(400);
  });

  it("returns a generic error for incorrect credentials", async () => {
    loginMock.mockResolvedValue(null);
    const response = await POST(
      loginRequest({ email: "ari@rebattery.io", password: "wrong" }),
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid credentials",
    });
  });

  it("sets the hardened session cookie after a successful login", async () => {
    loginMock.mockResolvedValue({
      id: "user-1",
      email: "ari@rebattery.io",
      displayName: "Ari",
    });
    createSessionMock.mockResolvedValue("session-token");
    sessionCookieMock.mockReturnValue({
      name: "denchclaw_session",
      value: "session-token",
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 28_800,
    });
    const response = await POST(
      loginRequest({ email: "ari@rebattery.io", password: "shared password" }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("Secure");
    expect(response.headers.get("set-cookie")).toContain("SameSite=lax");
    await expect(response.json()).resolves.toEqual({
      user: { email: "ari@rebattery.io", displayName: "Ari" },
    });
  });

  it("reports database or session failures as temporary unavailability", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    loginMock.mockRejectedValue(new Error("database unavailable"));
    const response = await POST(
      loginRequest({ email: "ari@rebattery.io", password: "shared password" }),
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Login temporarily unavailable",
    });
    spy.mockRestore();
  });
});
