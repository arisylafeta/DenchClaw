import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryPgMock, cookiesMock } = vi.hoisted(() => ({
  queryPgMock: vi.fn(),
  cookiesMock: vi.fn(),
}));

vi.mock("@/lib/postgres", () => ({ queryPg: queryPgMock }));
vi.mock("next/headers", () => ({ cookies: cookiesMock }));

import {
  createSession,
  currentUser,
  hashPassword,
  login,
  refreshSessionToken,
  revokeSession,
  sessionCookie,
  validateSessionToken,
  verifyPassword,
} from "./auth";

const userRow = async (overrides: Record<string, unknown> = {}) => ({
  id: "user-1",
  email: "ari@rebattery.io",
  display_name: "Ari",
  password_hash: await hashPassword("correct horse battery staple"),
  is_active: true,
  failed_login_count: 0,
  locked_until: null,
  ...overrides,
});

describe("CRM authentication", () => {
  beforeEach(() => {
    queryPgMock.mockReset();
    cookiesMock.mockReset();
  });

  it("hashes and verifies passwords without accepting malformed schemes", async () => {
    const encoded = await hashPassword("correct horse battery staple");
    expect(encoded).not.toContain("correct horse battery staple");
    await expect(
      verifyPassword("correct horse battery staple", encoded),
    ).resolves.toBe(true);
    await expect(verifyPassword("wrong", encoded)).resolves.toBe(false);
    await expect(
      verifyPassword(
        "correct horse battery staple",
        encoded.replace("scrypt$", "other$"),
      ),
    ).resolves.toBe(false);
    await expect(
      verifyPassword("correct horse battery staple", "malformed"),
    ).resolves.toBe(false);
  });

  it("allows only an active allowlisted user with the correct password", async () => {
    queryPgMock
      .mockResolvedValueOnce([await userRow()])
      .mockResolvedValueOnce([]);
    await expect(
      login(" ARI@rebattery.io ", "correct horse battery staple"),
    ).resolves.toEqual({
      id: "user-1",
      email: "ari@rebattery.io",
      displayName: "Ari",
    });
    expect(queryPgMock).toHaveBeenCalledTimes(2);
    expect(queryPgMock.mock.calls[0][1]).toEqual(["ari@rebattery.io"]);
    expect(queryPgMock.mock.calls[1][0]).toContain("failed_login_count = 0");
  });

  it("rejects unapproved emails and oversized passwords before querying", async () => {
    await expect(login("other@rebattery.io", "password")).resolves.toBeNull();
    await expect(
      login("ari@rebattery.io", "x".repeat(1025)),
    ).resolves.toBeNull();
    expect(queryPgMock).not.toHaveBeenCalled();
  });

  it("atomically records a failed password and locks after repeated failures", async () => {
    queryPgMock
      .mockResolvedValueOnce([await userRow({ failed_login_count: 9 })])
      .mockResolvedValueOnce([]);
    await expect(login("ari@rebattery.io", "wrong")).resolves.toBeNull();
    expect(queryPgMock.mock.calls[1][0]).toContain(
      "failed_login_count = failed_login_count + 1",
    );
    expect(queryPgMock.mock.calls[1][0]).toContain(
      "failed_login_count + 1 >= 10",
    );
  });

  it("rejects inactive and currently locked users without password verification writes", async () => {
    queryPgMock.mockResolvedValueOnce([await userRow({ is_active: false })]);
    await expect(
      login("ari@rebattery.io", "correct horse battery staple"),
    ).resolves.toBeNull();
    queryPgMock.mockReset();
    queryPgMock.mockResolvedValueOnce([
      await userRow({
        locked_until: new Date(Date.now() + 60_000).toISOString(),
      }),
    ]);
    await expect(
      login("ari@rebattery.io", "correct horse battery staple"),
    ).resolves.toBeNull();
    expect(queryPgMock).toHaveBeenCalledTimes(1);
  });

  it("creates opaque expiring sessions and secure production cookies", async () => {
    queryPgMock.mockResolvedValueOnce([]);
    const token = await createSession("user-1");
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(queryPgMock.mock.calls[0][0]).toContain("insert into crm_sessions");
    expect(queryPgMock.mock.calls[0][1][1]).not.toBe(token);
    const previous = process.env.NODE_ENV;
    vi.stubEnv("NODE_ENV", "production");
    expect(sessionCookie(token)).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 2_592_000,
    });
    vi.stubEnv("NODE_ENV", previous ?? "test");
  });

  it("validates only bounded session tokens returned by the database policy", async () => {
    await expect(validateSessionToken("short")).resolves.toBeNull();
    expect(queryPgMock).not.toHaveBeenCalled();
    queryPgMock.mockResolvedValueOnce([
      { id: "user-1", email: "ari@rebattery.io", display_name: "Ari" },
    ]);
    await expect(validateSessionToken("x".repeat(43))).resolves.toEqual({
      id: "user-1",
      email: "ari@rebattery.io",
      displayName: "Ari",
    });
    expect(queryPgMock.mock.calls[0][0]).toContain("s.revoked_at is null");
    expect(queryPgMock.mock.calls[0][0]).toContain("s.expires_at > now()");
    expect(queryPgMock.mock.calls[0][0]).toContain("u.is_active");
  });

  it("renews a valid active session for 30 days", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T12:00:00.000Z"));
    queryPgMock.mockResolvedValueOnce([
      { id: "user-1", email: "ari@rebattery.io", display_name: "Ari" },
    ]);

    await expect(refreshSessionToken("x".repeat(43))).resolves.toEqual({
      id: "user-1",
      email: "ari@rebattery.io",
      displayName: "Ari",
    });
    expect(queryPgMock.mock.calls[0][0]).toContain("update crm_sessions");
    expect(queryPgMock.mock.calls[0][0]).toContain("s.expires_at > now()");
    expect(queryPgMock.mock.calls[0][0]).toContain("u.is_active");
    expect(queryPgMock.mock.calls[0][1][1]).toEqual(
      new Date("2026-09-21T12:00:00.000Z"),
    );
    vi.useRealTimers();
  });

  it("does not renew malformed sessions or sessions rejected by database policy", async () => {
    await expect(refreshSessionToken("short")).resolves.toBeNull();
    expect(queryPgMock).not.toHaveBeenCalled();

    queryPgMock.mockResolvedValueOnce([]);
    await expect(refreshSessionToken("x".repeat(43))).resolves.toBeNull();
    expect(queryPgMock).toHaveBeenCalledOnce();
  });

  it("reads, refreshes, and revokes the current cookie session", async () => {
    const token = "x".repeat(43);
    cookiesMock.mockResolvedValue({ get: () => ({ value: token }) });
    queryPgMock
      .mockResolvedValueOnce([
        { id: "user-1", email: "ari@rebattery.io", display_name: "Ari" },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    await expect(currentUser()).resolves.toMatchObject({ displayName: "Ari" });
    await revokeSession();
    expect(queryPgMock.mock.calls[1][0]).toContain("last_seen_at");
    expect(queryPgMock.mock.calls[2][0]).toContain("revoked_at");
  });
});
