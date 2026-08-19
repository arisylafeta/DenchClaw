import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeMessageFilters } from "./contract";

const noStore = vi.fn();
const getSupabaseAdminClient = vi.fn();

vi.mock("next/cache", () => ({ unstable_noStore: noStore }));
vi.mock("@/lib/platform-admin/supabase", () => ({ getSupabaseAdminClient }));

function queryResult(data: unknown[], count?: number) {
  return { data, error: null, ...(count === undefined ? {} : { count }) };
}

function makeBuilder(result: ReturnType<typeof queryResult>, oneResult?: unknown) {
  const builder = {
    select: vi.fn(),
    eq: vi.fn(),
    gte: vi.fn(),
    lte: vi.fn(),
    ilike: vi.fn(),
    or: vi.fn(),
    in: vi.fn(),
    limit: vi.fn(),
    order: vi.fn(),
    range: vi.fn(),
    maybeSingle: vi.fn(),
    then: (resolve: (value: ReturnType<typeof queryResult>) => unknown) => Promise.resolve(result).then(resolve),
  };
  for (const method of ["select", "eq", "gte", "lte", "ilike", "or", "in", "limit", "order", "range"] as const) {
    (builder[method] as unknown as { mockReturnValue(value: unknown): void }).mockReturnValue(builder);
  }
  builder.maybeSingle.mockResolvedValue({ data: oneResult ?? result.data[0] ?? null, error: null });
  return builder;
}

describe("marketplace message monitoring reads", () => {
  beforeEach(() => vi.clearAllMocks());

  it("normalizes bounded filters and rejects unsupported moderation values", async () => {
    expect(normalizeMessageFilters({
      search: "  email, (phone)  ",
      from: "2026-08-01",
      to: "not-a-date",
      status: "pending",
    })).toEqual({
      search: "email phone",
      from: "2026-08-01",
      to: "",
      status: "pending",
    });
  });

  it("orders newest first, applies filters and hydrates context in bounded batches", async () => {
    const message = {
      id: "message-1",
      conversation_id: "conversation-1",
      sender_membership_id: "membership-1",
      body: "A monitored message",
      message_type: "user",
      is_system_seeded: false,
      created_at: "2026-08-19T10:00:00.000Z",
      updated_at: "2026-08-19T10:00:00.000Z",
      moderation_status: "delivered",
      moderation_reason_code: null,
      moderation_reason_text: null,
      moderation_policy_version: "reb124-v1",
      moderation_decision_source: "fail_open",
      moderation_attempt_count: 1,
      moderation_failure_code: "configuration",
      moderation_decided_at: "2026-08-19T10:00:01.000Z",
      attachment_file_name: null,
      attachment_content_type: null,
      attachment_size_bytes: null,
    };
    const conversation = {
      id: "conversation-1",
      listing_id: "listing-1",
      supplier_account_id: "supplier-1",
      counterparty_account_id: "buyer-1",
      conversation_type: "purchase",
      status: "open",
      last_message_at: message.created_at,
      last_message_preview: message.body,
      created_at: message.created_at,
      updated_at: message.updated_at,
    };
    const builders = new Map<string, ReturnType<typeof makeBuilder>>([
      ["conversation_messages", makeBuilder(queryResult([message], 1))],
      ["conversations", makeBuilder(queryResult([conversation]))],
      ["accounts", makeBuilder(queryResult([{ id: "supplier-1", name: "Supplier" }, { id: "buyer-1", name: "Buyer" }]))],
      ["listings", makeBuilder(queryResult([{ id: "listing-1", title: "Battery listing", reference: "REF-1", seo_slug: "battery-listing" }]))],
      ["account_memberships", makeBuilder(queryResult([{ id: "membership-1", account_id: "supplier-1", user_id: "user-1", membership_role: "owner" }]))],
      ["users", makeBuilder(queryResult([{ id: "user-1", email: "sender@example.test", full_name: "Sender" }]))],
    ]);
    getSupabaseAdminClient.mockReturnValue({ from: (table: string) => builders.get(table) });

    const { getMessagePage } = await import("./actions");
    const result = await getMessagePage({
      page: 2,
      search: "monitored",
      from: "2026-08-01",
      to: "2026-08-19",
      status: "delivered",
    });

    expect(result.rows[0]).toMatchObject({
      id: "message-1",
      sender: { displayName: "Sender", email: "sender@example.test" },
      conversation: { supplierName: "Supplier", counterpartyName: "Buyer" },
      listing: { title: "Battery listing", reference: "REF-1" },
    });
    const messageBuilder = builders.get("conversation_messages")!;
    expect(messageBuilder.order).toHaveBeenNthCalledWith(1, "created_at", { ascending: false });
    expect(messageBuilder.order).toHaveBeenNthCalledWith(2, "id", { ascending: false });
    expect(messageBuilder.range).toHaveBeenCalledWith(25, 49);
    expect(messageBuilder.or).toHaveBeenCalledWith(expect.stringContaining("body.ilike.%monitored%"));
    expect(messageBuilder.eq).toHaveBeenCalledWith("moderation_status", "delivered");
    expect(messageBuilder.eq).not.toHaveBeenCalledWith("moderation_decision_source", expect.anything());
    expect(messageBuilder.eq).not.toHaveBeenCalledWith("moderation_reason_code", expect.anything());
    expect(messageBuilder.gte).toHaveBeenCalledWith("created_at", "2026-08-01T00:00:00.000Z");
    expect(messageBuilder.lte).toHaveBeenCalledWith("created_at", "2026-08-19T23:59:59.999Z");
  });
});
