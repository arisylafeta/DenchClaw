import { describe, expect, it } from "vitest";
import {
  buildJulesStats,
  countWaitingOnUs,
  entryKey,
  isPlaceholderReply,
  laneOf,
  leadEmails,
  namesBattery,
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

function message(sessionId: string, role: "user" | "assistant", body: string, createdAt = iso(0)): RawMessage {
  return { session_id: sessionId, role, created_at: createdAt, body };
}

const events: RawEvent[] = [
  { conversation_id: "a", kind: "team_email_sent", at: iso(2) },
  { conversation_id: "b", kind: "team_email_sent", at: iso(3) },
  { conversation_id: "c", kind: "follow_up_sent", at: iso(4) },
  { conversation_id: "d", kind: "seller_email_reply", at: iso(5) },
  { conversation_id: "e", kind: "team_email_sent", at: iso(9) },
  // internal test address: never counted, like its chat
  { conversation_id: "s3", kind: "team_email_sent", at: iso(2) },
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

  it("does not count marketplace stock prices as a seller valuation", () => {
    const stats = buildJulesStats({
      now: NOW,
      sessions: [session({ id: "b1", source_surface: "buy-batteries", account_id: "acct-1" })],
      leads: [],
      events: [],
      messages: [{ session_id: "b1", role: "assistant", created_at: iso(0, -1), body: "US$350 buy-now, 1 available" }],
      turnErrors: [],
      mail: [],
    });
    expect(stats.current.totals.chats).toBe(1);
    expect(stats.current.totals.priceShown).toBe(0);
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
    message("s1", "user", "I'd like to sell 40 Leaf packs", iso(1)),
    message("s1", "assistant", "Those are worth about £4,000.", iso(1, 1)),
    message("s2", "user", "I have scrap to recycle", iso(2)),
    message("s5", "user", "here is the label", iso(4)),
    message("s5", "assistant", "I've started your draft listing.", iso(4, 0.5)),
    message("s6", "user", "hello", iso(9)),
    message("s6", "assistant", "Hello", iso(9, 2)),
  ];

  const turnErrors: RawTurnError[] = [
    { session_id: "s1", emitted_at: iso(1) },
    { session_id: "s1", emitted_at: iso(10) },
    // smoke-test chat: never counted
    { session_id: "s4", emitted_at: iso(3) },
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

  it("counts follow-up emails and replies in each window, ignoring staff and smoke-test chats", () => {
    expect(stats.current.followUps).toEqual({ teamEmails: 2, autoFollowUps: 1, sellerReplies: 1 });
    expect(stats.previous.followUps).toEqual({ teamEmails: 1, autoFollowUps: 0, sellerReplies: 0 });
  });

  it("splits the week by lane", () => {
    expect(stats.current.lanes).toEqual({ sales: 2, recycling: 1, buyer: 0 });
  });

  it("reports health: no reply, placeholder replies and failed turns, ignoring excluded chats", () => {
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

  it("counts a price from the recorded event, and from the reply text for older chats", () => {
    const value = (id: string, extra: { events?: RawEvent[]; messages?: RawMessage[] }) =>
      buildJulesStats({
        now: NOW,
        sessions: [session({ id, contact_email: `${id}@example.test` })],
        leads: [],
        events: extra.events ?? [],
        messages: extra.messages ?? [],
        turnErrors: [],
        mail: [],
      }).current.totals.priceShown;
    // The app writes this row when the valuation tool returns a range.
    expect(value("p1", { events: [{ conversation_id: "p1", kind: "price_shown", at: iso(0, -5) }] })).toBe(1);
    // No event: the currency pattern still keeps pre-event chats in the count.
    expect(value("p2", { messages: [message("p2", "assistant", "Around £1,200 for the lot.")] })).toBe(1);
    expect(value("p3", { messages: [message("p3", "assistant", "What condition are they in?")] })).toBe(0);
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

  it("applies the same skips as scripts/jules_waiting_on_us.py", () => {
    const at = (iso: string) => iso;
    const mail = [
      { email: "person@x.test", lastInboundAt: at("2026-11-26T10:00:00.000Z"), lastOutboundAt: at("2026-11-25T10:00:00.000Z") },
      // Marketplace and site notifications are not a person waiting.
      { email: "note@x.test", lastInboundAt: at("2026-11-26T10:00:00.000Z"), lastOutboundAt: null, lastSubject: "Re: New message about your listing" },
      // A thread another agent owns is theirs to answer.
      { email: "other@x.test", lastInboundAt: at("2026-11-26T10:00:00.000Z"), lastOutboundAt: null, threadOwner: "sorcerer" },
      // Alex or Ari already answered them by hand at or after their mail.
      { email: "handled@x.test", lastInboundAt: at("2026-11-26T10:00:00.000Z"), lastOutboundAt: null, handAnsweredAt: at("2026-11-26T12:00:00.000Z") },
      // Mail older than our first contact with the person is not this lead.
      { email: "old@x.test", lastInboundAt: at("2026-11-01T10:00:00.000Z"), lastOutboundAt: null },
      // Mail that predates the person's first chat, with no mail from us at all.
      { email: "junk@x.test", lastInboundAt: at("2026-08-01T10:00:00.000Z"), lastOutboundAt: null },
    ];
    const contact = {
      platformEmail: new Map([["old@x.test", "2026-11-10T10:00:00.000Z"]]),
      firstChat: new Map([["junk@x.test", "2026-11-10T10:00:00.000Z"]]),
    };
    expect(countWaitingOnUs(mail, [...mail.map((row) => row.email), "junk@x.test"], contact)).toBe(1);
    // A thread Jules owns and a hand reply older than their mail still count.
    expect(countWaitingOnUs(
      [{ email: "ours@x.test", lastInboundAt: at("2026-11-26T10:00:00.000Z"), lastOutboundAt: null, threadOwner: "papajules", handAnsweredAt: at("2026-11-20T10:00:00.000Z") }],
      ["ours@x.test"],
    )).toBe(1);
  });

  it("compares first contact by time, not by the text of the timestamp", () => {
    // String order would pick the fixed-offset value and place first contact after the mail.
    const mail = [{
      email: "offset@x.test",
      lastInboundAt: "2026-11-09T19:45:00.000Z",
      lastOutboundAt: null,
      firstOutboundAt: "2026-11-09T20:00:00.000Z",
    }];
    const contact = { platformEmail: new Map([["offset@x.test", "2026-11-10T00:30:00.000+05:00"]]), firstChat: new Map() };
    expect(countWaitingOnUs(mail, ["offset@x.test"], contact)).toBe(1);
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

describe("cohort funnel", () => {
  const lead = (over: Partial<RawLead> & { conversation_id: string }): RawLead => ({
    channel_mode: "sale",
    stage: "drafted",
    contact_email: null,
    ready_to_publish: false,
    listing_status: null,
    first_seen_at: iso(1),
    discarded_at: null,
    title: "Battery listing",
    draft: {},
    ...over,
  });

  const cohortOf = (sessions: RawSession[], leads: RawLead[] = [], messages: RawMessage[] = [], events: RawEvent[] = []) =>
    buildJulesStats({ now: NOW, sessions, leads, events, messages, turnErrors: [], mail: [] }).current.cohort;

  it("only counts a chat at a step when it passed every step before it", () => {
    const cohort = cohortOf(
      [session({ id: "full", contact_email: "full@example.test" }), session({ id: "quiet" })],
      [
        lead({ conversation_id: "full", title: "Samsung INR-18650VTC6", ready_to_publish: true, stage: "live", listing_status: "published" }),
      ],
      [message("full", "assistant", "That lot is worth about £2,400.")],
    );
    expect(cohort.started).toBe(2);
    expect(cohort.steps.map((step) => step.count)).toEqual([2, 1, 1, 1, 1, 1]);
    // Share is always of the started cohort, so the bars only ever get shorter.
    const counts = cohort.steps.map((step) => step.count);
    expect(counts).toEqual(counts.toSorted((a, b) => b - a));
    expect(cohort.steps[1].share).toBe(0.5);
  });

  it("counts an email left before any price: the price step does not gate later steps", () => {
    const cohort = cohortOf(
      [session({ id: "email-first", contact_email: "seller@example.test" })],
      [lead({ conversation_id: "email-first", title: "Growatt 6.5kWh", draft: { manufacturer: "Growatt" } })],
      [message("email-first", "user", "hello", iso(1))],
    );
    expect(cohort.steps.map((step) => step.count)).toEqual([1, 1, 0, 1, 0, 0]);
    // Email is measured from "said what the battery is", not from the price step.
    expect(cohort.steps[3].lost).toBe(0);
    expect(cohort.biggestDrop?.to).toBe("ready");
    expect(cohort.emailBeforePrice).toBe(1);
  });

  it("picks the transition that loses the most chats, and the earlier step on a tie", () => {
    const cohort = cohortOf(
      [
        session({ id: "a" }),
        session({ id: "b" }),
        session({ id: "c", contact_email: "c@example.test" }),
        session({ id: "d" }),
      ],
      [lead({ conversation_id: "a", title: "Samsung INR-18650VTC6" })],
      [message("c", "assistant", "Around £900 for the lot.")],
    );
    // a named a battery but was never priced; c was priced but never named, so c drops at
    // the named step: started 4, named 1, priced 0, and named loses 3.
    expect(cohort.steps.map((step) => step.count)).toEqual([4, 1, 0, 0, 0, 0]);
    expect(cohort.biggestDrop).toMatchObject({ to: "named", lost: 3 });
    expect(cohort.biggestDrop?.to).not.toBe("started");

    const tie = cohortOf([session({ id: "t1" }), session({ id: "t2" })], [lead({ conversation_id: "t1", title: "Tesla 5.2kWh" })], [
      message("t1", "assistant", "About $1,100."),
    ]);
    // named loses 1, priced loses 1: the earlier step wins.
    expect(tie.biggestDrop).toMatchObject({ to: "named", lost: 1 });
  });

  it("keeps buyer, recycling, staff and smoke-test chats out of the sales cohort", () => {
    const priced = [message("b1", "assistant", "US$350 buy-now, 1 available.")];
    const cohort = cohortOf(
      [
        session({ id: "b1", source_surface: "buy-batteries", account_id: "acct-1" }),
        session({ id: "r1", source_surface: "recycle-batteries" }),
        session({ id: "qa1", contact_email: "qa+smoke@rebattery.io" }),
        session({ id: "smoke", source_surface: "reb308-production-smoke-test" }),
        session({ id: "s1" }),
      ],
      [lead({ conversation_id: "b1", title: "Samsung INR-18650VTC6" })],
      priced,
    );
    expect(cohort.started).toBe(1);
    expect(cohort.byEntry.map((row) => row.entry)).toEqual(["sell"]);
  });

  it("counts a price from the reply text only when no event was recorded", () => {
    const reply = [message("p1", "assistant", "Around £1,200 for the lot.")];
    const textOnly = cohortOf([session({ id: "p1" })], [lead({ conversation_id: "p1", title: "Tesla 5.2kWh" })], reply);
    expect(textOnly.pricedFromText).toBe(1);
    expect(textOnly.steps[2].count).toBe(1);

    const withEvent = cohortOf(
      [session({ id: "p1" })],
      [lead({ conversation_id: "p1", title: "Tesla 5.2kWh" })],
      reply,
      [{ conversation_id: "p1", kind: "price_shown", at: iso(1) }],
    );
    expect(withEvent.pricedFromText).toBe(0);
    expect(withEvent.steps[2].count).toBe(1);
  });

  it("does not treat a discarded lead as ready or published", () => {
    const cohort = cohortOf(
      [session({ id: "gone", contact_email: "gone@example.test" })],
      [
        lead({
          conversation_id: "gone",
          title: "Tesla 5.2kWh",
          ready_to_publish: true,
          stage: "live",
          listing_status: "published",
          discarded_at: iso(0, -30),
        }),
      ],
      [message("gone", "assistant", "About £1,100.")],
    );
    expect(cohort.steps.map((step) => step.count)).toEqual([1, 1, 1, 1, 0, 0]);
  });

  it("handles a window with no sales chats", () => {
    const cohort = cohortOf([session({ id: "rec", source_surface: "recycle-batteries" })]);
    expect(cohort.started).toBe(0);
    expect(cohort.biggestDrop).toBeNull();
    expect(cohort.steps.every((step) => step.count === 0 && step.share === 0)).toBe(true);
    expect(cohort.byEntry).toEqual([]);
  });

  it("splits the same funnel by entry page", () => {
    const cohort = cohortOf(
      [
        session({ id: "s1", source_surface: "sell-batteries" }),
        session({ id: "s2", source_surface: "sell-batteries" }),
        session({ id: "h1", source_surface: "home" }),
      ],
      [lead({ conversation_id: "s1", title: "Samsung INR-18650VTC6" })],
    );
    expect(cohort.byEntry.map((row) => [row.entry, row.started, row.counts[1]])).toEqual([
      ["sell", 2, 1],
      ["home", 1, 0],
    ]);
  });

  it("names the battery from a real title or a draft manufacturer, not a generic title or a capacity", () => {
    expect(namesBattery([lead({ conversation_id: "x", title: "Battery listing" })])).toBe(false);
    expect(namesBattery([lead({ conversation_id: "x", title: "Whole chat sent to ReBattery" })])).toBe(false);
    expect(namesBattery([lead({ conversation_id: "x", title: "0.9kWh" })])).toBe(false);
    expect(namesBattery([lead({ conversation_id: "x", title: "Battery listing", draft: { model: "VTC6" } })])).toBe(true);
    expect(namesBattery([lead({ conversation_id: "x", title: "Growatt 6.5kWh" })])).toBe(true);
  });
});

describe("reply timing", () => {
  it("measures from the seller's first message and ignores chats where nobody typed", () => {
    const stats = buildJulesStats({
      now: NOW,
      sessions: [
        session({ id: "greeted", created_at: iso(1) }),
        session({ id: "silent", created_at: iso(1) }),
      ],
      leads: [],
      events: [],
      messages: [
        // a greeting with no seller message is not a chat waiting on a reply
        message("greeted", "assistant", "Hello, what are you selling?", iso(1)),
        message("silent", "user", "twenty Leaf packs", iso(1)),
      ],
      turnErrors: [],
      mail: [],
    });
    expect(stats.current.health.noReply).toBe(1);
    expect(stats.current.health.firstReplySeconds.answered).toBe(0);
  });

  it("treats a placeholder with a curly apostrophe as the same reply", () => {
    expect(isPlaceholderReply("I\u2019ve started your draft listing.")).toBe(true);
  });

  it("counts a chat that starts exactly at the window edge and not one at its end", () => {
    const from = new Date(NOW.getTime() - 7 * 86_400_000);
    const stats = buildJulesStats({
      now: NOW,
      sessions: [session({ id: "edge", created_at: from.toISOString() }), session({ id: "end", created_at: NOW.toISOString() })],
      leads: [],
      events: [],
      messages: [message("edge", "user", "hi", from.toISOString())],
      turnErrors: [],
      mail: [],
    });
    expect(stats.current.totals.chats).toBe(1);
    expect(stats.previous.totals.chats).toBe(0);
  });
});
