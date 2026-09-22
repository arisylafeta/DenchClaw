import { describe, expect, it, vi } from "vitest";

const { Configuration, ServerClient } = vi.hoisted(() => ({
  Configuration: vi.fn(),
  ServerClient: vi.fn(),
}));

vi.mock("postmark", () => ({
  ServerClient,
  Models: { ClientOptions: { Configuration } },
}));

vi.mock("@/lib/platform-admin/env", () => ({
  getPostmarkEnv: () => ({ postmarkServerToken: "postmark-token" }),
}));

import { getPostmarkClient } from "./client";

describe("getPostmarkClient", () => {
  it("keeps Postmark's API hostname when overriding the timeout", () => {
    getPostmarkClient();

    expect(Configuration).toHaveBeenCalledWith(true, "api.postmarkapp.com", 15);
    expect(ServerClient).toHaveBeenCalledWith("postmark-token", Configuration.mock.instances[0]);
  });
});
