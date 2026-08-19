import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("platform admin Supabase networking", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("retries bounded transient read failures", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: "account-1" }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const { getSupabaseAdminClient } = await import("./supabase");
    const started = Date.now();
    const { data, error } = await getSupabaseAdminClient()
      .from("accounts")
      .select("id")
      .limit(1);

    expect(error).toBeNull();
    expect(data).toEqual([{ id: "account-1" }]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("never retries a write after a transport failure", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: "account-1" }]), {
        status: 201,
        headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const { getSupabaseAdminClient } = await import("./supabase");
    await getSupabaseAdminClient().from("accounts").insert({
      id: "account-1",
      name: "Test account",
      role: "buyer",
      account_type: "organization",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });
});
