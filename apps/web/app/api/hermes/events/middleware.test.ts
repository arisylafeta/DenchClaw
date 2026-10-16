import { beforeEach, expect, it, vi } from "vitest";
vi.mock("@/lib/auth", () => ({ refreshSessionToken: vi.fn(async () => true), sessionCookie: vi.fn(() => ({ name: "denchclaw_session", value: "session" })) }));
import { NextRequest } from "next/server";
import { middleware } from "../../../../middleware";
import { refreshSessionToken } from "@/lib/auth";
beforeEach(() => vi.clearAllMocks());
it("covers new Hermes routes with session auth and same-origin CSRF", async () => {
  const anonymous = await middleware(new NextRequest("https://crm.example/api/hermes/events"));
  expect(anonymous.status).toBe(401);
  const forbidden = await middleware(new NextRequest("https://crm.example/api/hermes/conversations/key/prompt", { method: "POST", headers: { cookie: "denchclaw_session=valid", origin: "https://evil.example" } }));
  expect(forbidden.status).toBe(403);
  expect(refreshSessionToken).not.toHaveBeenCalled();
  const accepted = await middleware(new NextRequest("https://crm.example/api/hermes/events/subscriptions", { method: "POST", headers: { cookie: "denchclaw_session=valid", origin: "https://crm.example" } }));
  expect(accepted.status).toBe(200);
  expect(refreshSessionToken).toHaveBeenCalledWith("valid");
});
