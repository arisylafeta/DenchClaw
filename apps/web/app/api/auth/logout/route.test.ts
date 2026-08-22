import { beforeEach, describe, expect, it, vi } from "vitest";

const { revokeSessionMock } = vi.hoisted(() => ({
  revokeSessionMock: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  revokeSession: revokeSessionMock,
  SESSION_COOKIE: "denchclaw_session",
}));

import { POST } from "./route";

describe("POST /api/auth/logout", () => {
  beforeEach(() => revokeSessionMock.mockReset());

  it("revokes the session and always clears the browser cookie", async () => {
    const response = await POST();

    expect(response.status).toBe(200);
    expect(revokeSessionMock).toHaveBeenCalledOnce();
    expect(response.headers.get("set-cookie")).toContain(
      "denchclaw_session=",
    );
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});
