import { beforeEach, describe, expect, it, vi } from "vitest";

const { currentUser, getSupabaseAdminClient, queryPg } = vi.hoisted(() => ({
  currentUser: vi.fn(),
  getSupabaseAdminClient: vi.fn(),
  queryPg: vi.fn(),
}));

vi.mock("next/cache", () => ({ unstable_noStore: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({
  currentUser,
  ALLOWED_EMAILS: new Set(["ari@rebattery.io", "alex@rebattery.io"]),
}));
vi.mock("@/lib/platform-admin/supabase", () => ({ getSupabaseAdminClient }));
vi.mock("@/lib/postgres", () => ({ queryPg }));

import { loadJulesStats, readMailActivity } from "./reads";

type Rows = Record<string, unknown[]>;

function client(rows: Rows) {
  const seen: { table: string; calls: string[] }[] = [];
  const from = vi.fn((table: string) => {
    const entry = { table, calls: [] as string[] };
    seen.push(entry);
    const builder: Record<string, unknown> = {
      select: vi.fn((columns: string) => (entry.calls.push(`select ${columns}`), builder)),
      gte: vi.fn((column: string, value: string) => (entry.calls.push(`gte ${column} ${value}`), builder)),
      eq: vi.fn((column: string, value: string) => (entry.calls.push(`eq ${column} ${value}`), builder)),
      in: vi.fn((column: string, values: string[]) => (entry.calls.push(`in ${column} ${values.join(",")}`), builder)),
      or: vi.fn((filter: string) => (entry.calls.push(`or ${filter}`), builder)),
      order: vi.fn((column: string) => (entry.calls.push(`order ${column}`), builder)),
      range: vi.fn((from_: number, to: number) => (entry.calls.push(`range ${from_}-${to}`), builder)),
      // oxlint-disable-next-line unicorn/no-thenable -- Supabase query builders are thenable.
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: rows[table] ?? [], error: null }).then(resolve),
    };
    return builder;
  });
  getSupabaseAdminClient.mockReturnValue({ from });
  return { from, seen };
}

const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();

beforeEach(() => {
  vi.clearAllMocks();
  currentUser.mockResolvedValue({ email: "ari@rebattery.io" });
  queryPg.mockResolvedValue([]);
});

describe("jules stats reads", () => {
  it.each([null, { email: "someone@example.test" }])("denies unauthorized access: %j", async (user) => {
    currentUser.mockResolvedValue(user);
    await expect(loadJulesStats()).rejects.toThrow("Unauthorized");
    expect(getSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("reads every source read-only and builds the funnel", async () => {
    const { seen } = client({
      jules_sessions: [
        {
          id: "s1",
          source_surface: "sell-batteries",
          created_at: iso(1),
          contact_email: "seller@example.test",
          account_id: null,
          created_by_user_id: null,
          owner_auth_user_id: null,
        },
      ],
      intake_leads: [
        {
          conversation_id: "s1",
          channel_mode: "sale",
          stage: "ready",
          contact_email: null,
          ready_to_publish: true,
          listing_status: null,
          first_seen_at: iso(1),
          discarded_at: null,
        },
      ],
      intake_lead_events: [{ conversation_id: "s1", kind: "team_email_sent", at: iso(1) }],
      jules_messages: [
        { session_id: "s1", role: "assistant", created_at: iso(1), body: "That is worth about £1,200." },
      ],
      jules_events: [{ session_id: "s1", emitted_at: iso(1) }],
    });
    queryPg.mockResolvedValue([{ email: "seller@example.test", last_inbound_at: iso(0), last_outbound_at: iso(2) }]);

    const stats = await loadJulesStats();

    expect(stats.current.totals).toEqual({
      chats: 1,
      priceShown: 1,
      emailLeft: 1,
      readyToPublish: 1,
      published: 0,
    });
    expect(stats.current.followUps.teamEmails).toBe(1);
    expect(stats.current.health.waitingOnUs).toBe(1);
    expect(seen.map((entry) => entry.table)).toEqual([
      "jules_sessions",
      "intake_leads",
      "intake_lead_events",
      "jules_messages",
      "jules_events",
    ]);
    const sessions = seen.find((entry) => entry.table === "jules_sessions")!;
    // All chats, like scripts/jules_waiting_on_us.py: first contact and first chat need the history.
    expect(sessions.calls).not.toContainEqual(expect.stringMatching(/^gte created_at /));
    expect(sessions.calls).toContainEqual(expect.stringMatching(/^range 0-999$/));
    const events = seen.find((entry) => entry.table === "intake_lead_events")!;
    expect(events.calls).not.toContainEqual(expect.stringMatching(/^gte at /));
    // Only read fields; never select * from the platform.
    expect(sessions.calls[0]).toBe(
      "select id, source_surface, created_at, contact_email, account_id, created_by_user_id, owner_auth_user_id",
    );
  });

  it("surfaces a read failure without leaking the database message", async () => {
    getSupabaseAdminClient.mockReturnValue({
      from: () => ({
        select: () => {
          const builder = {
            gte: () => builder,
            or: () => builder,
            eq: () => builder,
            in: () => builder,
            order: () => builder,
            range: () => builder,
            // oxlint-disable-next-line unicorn/no-thenable -- Supabase query builders are thenable.
            then: (resolve: (value: unknown) => unknown) =>
              Promise.resolve({ data: null, error: { message: "seller1@example.test secret" } }).then(resolve),
          };
          return builder;
        },
      }),
    });
    await expect(loadJulesStats()).rejects.toThrow(/^Unable to read Jules activity$/);
  });
});

describe("mail activity", () => {
  it("maps one row per lead address", async () => {
    queryPg.mockResolvedValue([
      {
        email: "A@X.test",
        last_inbound_at: "2026-11-26T10:00:00Z",
        last_subject: "Re: Nissan Leaf packs",
        last_thread: "thread-1",
        last_outbound_at: "2026-11-25T10:00:00Z",
        first_outbound_at: "2026-11-01T10:00:00Z",
        hand_answered_at: null,
        thread_owner: "papajules",
      },
      { email: null, last_inbound_at: null, last_outbound_at: null },
    ]);
    expect(await readMailActivity(["a@x.test"])).toEqual([
      {
        email: "a@x.test",
        lastInboundAt: "2026-11-26T10:00:00.000Z",
        lastSubject: "Re: Nissan Leaf packs",
        lastOutboundAt: "2026-11-25T10:00:00.000Z",
        firstOutboundAt: "2026-11-01T10:00:00.000Z",
        handAnsweredAt: null,
        threadOwner: "papajules",
      },
    ]);
    expect(queryPg).toHaveBeenCalledWith(expect.stringContaining("from mail_message"), [["a@x.test"]]);
  });

  it("does not query the CRM when there are no lead addresses", async () => {
    expect(await readMailActivity([])).toEqual([]);
    expect(queryPg).not.toHaveBeenCalled();
  });
});
