import { describe, expect, it } from "vitest";
import {
  buildJulesStats,
  countWaitingOnUs,
  entryKey,
  isPlaceholderReply,
  laneOf,
  leadEmails,
  percentile,
  showsPrice,
  type RawEvent,
  type RawLead,
  type RawMessage,
  type RawSession,
  type RawTurnError,
} from "./metrics";

const NOW = new Date("2026-11-26T12:00:00.000Z");
const iso = (daysAgo: number, minutes = 0) =>
  new Date(NOW.getTime() - daysAgo * 86_400_000 + minutes * 60_000).toISOString();

function session(over: Partial<RawSession> & { id: string }): RawSession {
  return {
    source_surface: "sell-batteries",
    created_at: iso(1),
    contact_email: null,
    account_id: null,
    created_by_user_id: null,
    owner_auth_user_id: null,
    ...over,
  };
}

function message(sessionId: string, role: "user" | "assistant", body: string, minutesAgo = 0): RawMessage {
  return { session_id: sessionId, role, created_at: iso(0, -minutesAgo), body };
}

const events: RawEvent[] = [
  { conversation_id: "a", kind: "team_email_sent", at: iso(2) },
  { conversation_id: "b", kind: "team_email_sent", at: iso(3) },
  { conversation_id: "c", kind: "follow_up_sent", at: iso(4) },
  { conversation_id: "d", kind: "seller_email_reply", at: iso(5) },
  { conversation_id: "e", kind: "team_email_sent", at: iso(9) },
];

describe("entry attribution", () => {
  it("maps each landing surface to its card", () => {
    expect(entryKey("sell-batteries", false)).toBe("sell");
    expect(entryKey("recycle-batteries", false)).toBe("recycle");
    expect(entryKey("home", false)).toBe("home");
    expect(entryKey("buy-batteries", false)).toBe("buyer");
    expect(entryKey("recycler-directory", false)).toBe("directory");
    expect(entryKey(null, true)).toBe("dashboard");
    expect(entryKey("joules-text", true)).toBe("dashboard");
  });

  it("treats a signed-out chat with no page as lost attribution", () => {
    expect(entryKey(null, false)).toBe("other");
    expect(entryKey("joules-text", false)).toBe("other");
  });
});

describe("lanes", () => {
  it("splits recycling, buyer and sales chats", () => {
    expect(laneOf(session({ id: "1" }), false)).toBe("sales");
    expect(laneOf(session({ id: "2", source_surface: "recycle-batteries" }), false)).toBe("recycling");
    expect(laneOf(session({ id: "3", source_surface: "recycler-directory" }), false)).toBe("recycling");
    expect(laneOf(session({ id: "4", source_surface: "buy-batteries" }), false)).toBe("buyer");
    expect(laneOf(session({ id: "5" }), true)).toBe("recycling");
  });
});

describe("reply classification", () => {
  it("counts a reply quoting a price", () => {
    expect(showsPrice("That lot is worth about £2,400.")).toBe(true);
    expect(showsPrice("Around 120 EUR per pack")).toBe(true);
    expect(showsPrice("$900 for the set")).toBe(true);
  });

  it("does not count a reply that only talks about price without a figure", () => {
    expect(showsPrice("I can price this once I have the kWh.")).toBe(false);
    expect(showsPrice(null)).toBe(false);
  });

  it("treats blank and the draft-started line as placeholder replies", () => {
    expect(isPlaceholderReply("I've started your draft listing.")).toBe(true);
    expect(isPlaceholderReply("  I've started your draft listing.  ")).toBe(true);
    expect(isPlaceholderReply("")).toBe(true);
    expect(isPlaceholderReply("I've started your draft listing for the LFP pack, at 90% health.")).toBe(false);
  });
});

describe("percentile", () => {
  it("interpolates and rounds to a tenth", () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([10], 0.9)).toBe(10);
    expect(percentile([10, 20], 0.5)).toBe(15);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9.1);
  });
});

describe("buildJulesStats", () => {
  const sessions: RawSession[] = [
    // this week: sell card, priced reply, email left, ready to publish
    session({ id: "s1", contact_email: "seller1@example.test", created_at: iso(1) }),
    // this week: recycle card, no reply at all
    session({ id: "s2", source_surface: "recycle-batteries", created_at: iso(2) }),
    // this week: internal address, excluded
    session({ id: "s3", contact_email: "ari@rebattery.io", created_at: iso(2) }),
    // this week: smoke test surface, excluded
    session({ id: "s4", source_surface: "reb308-production-smoke-test", created_at: iso(3) }),
    // this week: signed-in dashboard chat, published lead
    session({ id: "s5", source_surface: null, account_id: "acct-1", created_at: iso(4) }),
    // last week: homepage chat
    session({ id: "s6", source_surface: "home", created_at: iso(9) }),
  ];

  const leads: RawLead[] = [
    {
      conversation_id: "s1",
      channel_mode: "sale",
      stage: "drafted",
      contact_email: null,
      ready_to_publish: true,
      listing_status: null,
      first_seen_at: iso(1),
      discarded_at: null,
    },
    {
      conversation_id: "s5",
      channel_mode: "sale",
      stage: "live",
      contact_email: null,
      ready_to_publish: true,
      listing_status: "published",
      first_seen_at: iso(4),
      discarded_at: null,
    },
    {
      conversation_id: "s2",
      channel_mode: "recycling",
      stage: "drafted",
      contact_email: null,
      ready_to_publish: false,
      listing_status: null,
      first_seen_at: iso(2),
      discarded_at: null,
    },
  ];

  const messages: RawMessage[] = [
    message("s1", "user", "I'd like to sell 40 Leaf packs"),
    { session_id: "s1", role: "assistant", created_at: iso(1, 1), body: "Those are worth about £4,000." },
    message("s2", "user", "I have scrap to recycle"),
    { session_id: "s5", role: "assistant", created_at: iso(4, 0.5), body: "I've started your draft listing." },
    message("s5", "user", "here is the label", 0.25),
    { session_id: "s6", role: "assistant", created_at: iso(9, 2), body: "Hello" },
  ];

  const turnErrors: RawTurnError[] = [
    { session_id: "s1", emitted_at: iso(1) },
    { session_id: "s1", emitted_at: iso(10) },
  ];

  const mail = [
    { email: "seller1@example.test", lastInboundAt: iso(0, -30), lastOutboundAt: iso(1) },
    { email: "quiet@example.test", lastInboundAt: iso(3), lastOutboundAt: iso(1) },
  ];

  const stats = buildJulesStats({ now: NOW, sessions, leads, events, messages, turnErrors, mail });

  it("counts this week's cohort and ignores internal and smoke-test chats", () => {
    expect(stats.current.totals.chats).toBe(3);
    expect(stats.current.funnel.map((row) => row.entry)).toEqual(["sell", "recycle", "dashboard"]);
  });

  it("shows the funnel per entry with counts beside rates", () => {
    const sell = stats.current.funnel.find((row) => row.entry === "sell")!;
    expect(sell).toMatchObject({ chats: 1, priceShown: 1, emailLeft: 1, readyToPublish: 1, published: 0 });
    const dashboard = stats.current.funnel.find((row) => row.entry === "dashboard")!;
    expect(dashboard).toMatchObject({ chats: 1, priceShown: 0, emailLeft: 1, readyToPublish: 1, published: 1 });
  });

  it("compares against the previous seven days", () => {
    expect(stats.previous.totals.chats).toBe(1);
    expect(stats.previous.funnel[0]).toMatchObject({ entry: "home", chats: 1, emailLeft: 0 });
  });

  it("counts follow-up emails and replies in each window", () => {
    expect(stats.current.followUps).toEqual({ teamEmails: 2, autoFollowUps: 1, sellerReplies: 1 });
    expect(stats.previous.followUps).toEqual({ teamEmails: 1, autoFollowUps: 0, sellerReplies: 0 });
  });

  it("splits the week by lane", () => {
    expect(stats.current.lanes).toEqual({ sales: 2, recycling: 1, buyer: 0 });
  });

  it("reports health: no reply, placeholder replies and failed turns", () => {
    expect(stats.current.health.noReply).toBe(1);
    expect(stats.current.health.placeholderReplies).toBe(1);
    expect(stats.current.health.failedTurns).toBe(1);
  });

  it("measures time to first reply for chats that got one", () => {
    // s1 replied after 60s, s5 after 30s; s2 never replied.
    expect(stats.current.health.firstReplySeconds.answered).toBe(2);
    expect(stats.current.health.firstReplySeconds.p50).toBe(45);
    expect(stats.current.health.firstReplySeconds.p90).toBe(57);
  });

  it("counts leads whose last email is from the seller", () => {
    expect(stats.current.health.waitingOnUs).toBe(1);
  });
});

describe("waiting on us", () => {
  it("counts only leads whose newest inbound mail is unanswered", () => {
    const mail = [
      { email: "a@x.test", lastInboundAt: "2026-11-26T10:00:00.000Z", lastOutboundAt: "2026-11-25T10:00:00.000Z" },
      { email: "b@x.test", lastInboundAt: "2026-11-24T10:00:00.000Z", lastOutboundAt: "2026-11-25T10:00:00.000Z" },
      { email: "c@x.test", lastInboundAt: null, lastOutboundAt: "2026-11-25T10:00:00.000Z" },
      { email: "d@x.test", lastInboundAt: "2026-11-24T10:00:00.000Z", lastOutboundAt: null },
    ];
    expect(countWaitingOnUs(mail, ["a@x.test", "b@x.test", "c@x.test", "d@x.test"])).toBe(2);
  });

  it("ignores addresses that are not sales leads", () => {
    const mail = [{ email: "z@x.test", lastInboundAt: "2026-11-26T10:00:00.000Z", lastOutboundAt: null }];
    expect(countWaitingOnUs(mail, ["a@x.test"])).toBe(0);
  });

  it("collects sales-lead emails only, without recycling or internal chats", () => {
    const emails = leadEmails({
      sessions: [
        session({ id: "s1", contact_email: "Seller1@Example.test" }),
        session({ id: "s2", source_surface: "recycle-batteries", contact_email: "recycler@example.test" }),
        session({ id: "s3", contact_email: "alex@rebattery.io" }),
      ],
      leads: [],
      events: [],
      messages: [],
      turnErrors: [],
      mail: [],
    });
    expect(emails).toEqual(["seller1@example.test"]);
  });
});
