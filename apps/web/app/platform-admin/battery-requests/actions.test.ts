import { beforeEach, describe, expect, it, vi } from "vitest";

const { currentUser, getSupabaseAdminClient } = vi.hoisted(() => ({
  currentUser: vi.fn(),
  getSupabaseAdminClient: vi.fn(),
}));

vi.mock("next/cache", () => ({ unstable_noStore: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  currentUser,
  ALLOWED_EMAILS: new Set(["ari@rebattery.io", "alex@rebattery.io"]),
}));
vi.mock("@/lib/platform-admin/supabase", () => ({ getSupabaseAdminClient }));

import { getBatteryInquiryChat } from "./actions";

function thenable(result: { data: unknown; error: unknown }) {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn(),
    in: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(),
    // Supabase query builders intentionally implement PromiseLike.
    // oxlint-disable-next-line unicorn/no-thenable
    then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
  for (const method of ["select", "eq", "maybeSingle", "in", "order", "limit"] as const) {
    query[method].mockReturnValue(query);
  }
  return query;
}

function client(
  inquiryResult: { data: unknown; error: unknown },
  messageResult: { data: unknown; error: unknown },
) {
  const inquiryQuery = thenable(inquiryResult);
  const messageQuery = thenable(messageResult);
  const from = vi.fn((table: string) =>
    table === "battery_requests" ? inquiryQuery : messageQuery,
  );
  getSupabaseAdminClient.mockReturnValue({ from });
  return { from, inquiryQuery, messageQuery };
}

beforeEach(() => {
  vi.clearAllMocks();
  currentUser.mockResolvedValue({ email: "ari@rebattery.io" });
});

describe("battery inquiry chat", () => {
  it.each([null, { email: "someone@example.test" }])(
    "denies unauthorized access: %j",
    async (user) => {
      currentUser.mockResolvedValue(user);
      await expect(getBatteryInquiryChat("inquiry-1")).rejects.toThrow("Unauthorized");
      expect(getSupabaseAdminClient).not.toHaveBeenCalled();
    },
  );

  it("returns the inquiry's ordered visitor and Joules messages", async () => {
    const { from, inquiryQuery, messageQuery } = client(
      {
        data: {
          id: "inquiry-1",
          session_id: "session-1",
          contact_email: "battery@example.test",
          created_at: "2026-09-08T12:03:00Z",
        },
        error: null,
      },
      {
        data: [
          {
            id: "message-2",
            sequence: 2,
            role: "assistant",
            body: "Reply",
            created_at: "2026-09-08T12:01:00Z",
          },
          {
            id: "message-1",
            sequence: 1,
            role: "user",
            body: "Question",
            created_at: "2026-09-08T12:00:00Z",
          },
        ],
        error: null,
      },
    );

    await expect(getBatteryInquiryChat("inquiry-1")).resolves.toEqual({
      inquiryId: "inquiry-1",
      contactEmail: "battery@example.test",
      createdAt: "2026-09-08T12:03:00Z",
      messages: [
        {
          id: "message-1",
          sequence: 1,
          role: "user",
          body: "Question",
          createdAt: "2026-09-08T12:00:00Z",
        },
        {
          id: "message-2",
          sequence: 2,
          role: "assistant",
          body: "Reply",
          createdAt: "2026-09-08T12:01:00Z",
        },
      ],
    });
    expect(from.mock.calls).toEqual([["battery_requests"], ["jules_messages"]]);
    expect(inquiryQuery.select).toHaveBeenCalledWith(
      "id, session_id, contact_email, created_at",
    );
    expect(inquiryQuery.eq).toHaveBeenCalledWith("id", "inquiry-1");
    expect(messageQuery.in).toHaveBeenCalledWith("role", ["user", "assistant"]);
    expect(messageQuery.limit).toHaveBeenCalledWith(100);
  });

  it("returns null when the inquiry no longer exists", async () => {
    const { from } = client({ data: null, error: null }, { data: [], error: null });
    await expect(getBatteryInquiryChat("missing")).resolves.toBeNull();
    expect(from).toHaveBeenCalledExactlyOnceWith("battery_requests");
  });

  it("does not expose database diagnostics", async () => {
    client(
      {
        data: {
          id: "inquiry-1",
          session_id: "session-1",
          contact_email: "x",
          created_at: "x",
        },
        error: null,
      },
      { data: null, error: { message: "private chat diagnostic" } },
    );
    await expect(getBatteryInquiryChat("inquiry-1")).rejects.toThrow(
      /^Unable to load inquiry chat$/,
    );
  });
});
