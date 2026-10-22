import { describe, expect, it } from "vitest";
import {
  dealsByWeek, distinctBuyers, enquiries, enquiriesByWeek, fees, internalBuyer, paidByWeek, paidDeals, paidInMonth,
  platformHome, realDeals, replyBuckets, sinceLastDeal, thirtyDayBlocks, type PlatformRows,
} from "./home-platform";
import { weekRange } from "./home-metrics";

const NOW = new Date("2026-10-22T15:00:00Z");
// A test buyer from marketplace-pulse-exclusions.json.
const TEST_BUYER = "9e9334fc-bda0-536b-a053-5c9164c89758";
const STAFF_BUYER = "staff-account";
const emails = new Map([[STAFF_BUYER, ["ari@rebattery.io"]], ["buyer-a", ["jo@recycler.example.org"]]]);

const rows = (over: Partial<PlatformRows> = {}): PlatformRows => ({
  deals: [], payments: [], offers: [], conversations: [], messages: [],
  accountEmails: emails, accountNames: new Map(), ...over,
});

type Payment = PlatformRows["payments"][number];
const pay = (over: Partial<Payment>): Payment => ({
  deal_id: "d1", status: "captured", payment_purpose: "initial", amount: 100, currency: "gbp",
  platform_fee_amount: 10, captured_at: "2026-10-02T15:33:27Z", created_at: "2026-10-02T15:33:26Z", ...over,
});

describe("exclusions", () => {
  it("leaves out listed test buyers, staff members and missing buyers", () => {
    expect(internalBuyer(TEST_BUYER, emails)).toBe(true);
    expect(internalBuyer(STAFF_BUYER, emails)).toBe(true);
    expect(internalBuyer(null, emails)).toBe(true);
    expect(internalBuyer("buyer-a", emails)).toBe(false);
  });

  it("leaves out deals with a test buyer or a test seller", () => {
    const deals = realDeals(rows({
      deals: [
        { id: "real", created_at: "2026-10-02T00:00:00Z", supplier_account_id: "seller", counterparty_account_id: "buyer-a" },
        { id: "test-buyer", created_at: "2026-10-02T00:00:00Z", supplier_account_id: "seller", counterparty_account_id: TEST_BUYER },
        { id: "test-seller", created_at: "2026-10-02T00:00:00Z", supplier_account_id: "97052761-e067-4b33-b8bf-cbac46e7f9d2", counterparty_account_id: "buyer-a" },
      ],
    }));
    expect(deals.map((d) => d.id)).toEqual(["real"]);
  });
});

describe("enquiries", () => {
  const list = enquiries(rows({
    offers: [
      { buyer_account_id: "buyer-a", created_at: "2026-10-19T09:00:00Z" },
      { buyer_account_id: TEST_BUYER, created_at: "2026-10-19T09:00:00Z" },
    ],
    conversations: [
      // The same buyer messaging the same week counts once.
      { id: "c1", counterparty_account_id: "buyer-a", created_at: "2026-10-20T09:00:00Z" },
      { id: "c2", counterparty_account_id: "buyer-b", created_at: "2026-10-18T23:00:00Z" },
      { id: "c3", counterparty_account_id: STAFF_BUYER, created_at: "2026-10-20T09:00:00Z" },
    ],
  }));

  it("counts distinct real buyers per week from offers and buyer conversations", () => {
    expect(list).toHaveLength(3);
    expect(enquiriesByWeek(list, ["2026-10-12", "2026-10-19"])).toEqual([1, 1]);
  });

  it("counts distinct buyers in a window and in 30-day blocks", () => {
    expect(distinctBuyers(list, Date.parse("2026-10-01T00:00:00Z"), Date.parse("2026-10-25T00:00:00Z"))).toBe(2);
    expect(thirtyDayBlocks((from, to) => distinctBuyers(list, from, to), NOW)).toEqual([0, 0, 2]);
  });
});

describe("deals opened", () => {
  const deals = [
    { id: "a", created_at: "2026-09-29T10:00:00Z", supplier_account_id: "s", counterparty_account_id: "buyer-a" },
    { id: "b", created_at: "2026-10-02T15:33:25Z", supplier_account_id: "s", counterparty_account_id: "buyer-a" },
  ];

  it("counts deals per week by when they were created", () => {
    expect(dealsByWeek(deals, ["2026-09-21", "2026-09-28", "2026-10-05"])).toEqual([0, 2, 0]);
  });

  it("counts days since the newest deal and distinct buyers who enquired after it", () => {
    const signals = [
      { account_id: "x", at: "2026-10-01T00:00:00Z" },
      { account_id: "y", at: "2026-10-05T00:00:00Z" },
      { account_id: "y", at: "2026-10-06T00:00:00Z" },
      { account_id: "z", at: "2026-10-21T00:00:00Z" },
    ];
    expect(sinceLastDeal(deals, signals, NOW)).toEqual({ last_at: "2026-10-02T15:33:25Z", days: 19, enquiries_since: 2 });
    expect(sinceLastDeal([], signals, NOW)).toBeNull();
  });
});

describe("paid deals", () => {
  const ids = new Set(["d1", "d2", "d3", "d4"]);

  it("counts a deal on the day its first initial payment of at least £50 was captured", () => {
    const paid = paidDeals([
      // Opened in September, paid in October: an October deal.
      pay({ deal_id: "d1", captured_at: "2026-10-02T15:33:27Z" }),
      pay({ deal_id: "d1", captured_at: "2026-10-09T00:00:00Z" }),
      // Card test under £50.
      pay({ deal_id: "d2", amount: "1.10" }),
      // Reconciliation is not a new paid deal.
      pay({ deal_id: "d3", payment_purpose: "reconciliation" }),
      // No captured_at: falls back to created_at.
      pay({ deal_id: "d4", captured_at: null, created_at: "2026-09-29T14:39:53Z" }),
      pay({ deal_id: "other" }),
      pay({ deal_id: "d1", status: "failed", captured_at: "2026-09-01T00:00:00Z" }),
    ], ids);
    expect(paid).toEqual([
      { deal_id: "d4", paid_at: "2026-09-29T14:39:53Z" },
      { deal_id: "d1", paid_at: "2026-10-02T15:33:27Z" },
    ]);
    expect(paidInMonth(paid, "2026-10")).toBe(1);
    expect(paidInMonth(paid, "2026-09")).toBe(1);
    expect(paidByWeek(paid, ["2026-09-28"])).toEqual([2]);
  });
});

describe("fees", () => {
  it("adds fees of every purpose by capture date, converts euros, and finds the largest deal's share", () => {
    const totals = fees([
      pay({ deal_id: "d1", platform_fee_amount: "17012.12", captured_at: "2026-08-13T00:35:32Z" }),
      pay({ deal_id: "d1", payment_purpose: "reconciliation", platform_fee_amount: "6771.60", captured_at: "2026-10-06T14:02:43Z" }),
      pay({ deal_id: "d2", currency: "eur", platform_fee_amount: "400.00", captured_at: "2026-09-29T15:46:46Z" }),
      pay({ deal_id: "d3", platform_fee_amount: "155.00", captured_at: "2026-10-02T15:33:27Z" }),
      // Last year, another currency, a test deal and an uncaptured payment are left out.
      pay({ deal_id: "d3", platform_fee_amount: 999, captured_at: "2025-12-30T00:00:00Z" }),
      pay({ deal_id: "d4", currency: "usd", platform_fee_amount: 50 }),
      pay({ deal_id: "test", platform_fee_amount: 2 }),
      pay({ deal_id: "d3", status: "requires_payment", platform_fee_amount: 70 }),
    ], new Set(["d1", "d2", "d3", "d4"]), NOW);
    expect(totals.ytd_gbp).toBeCloseTo(17012.12 + 6771.6 + 344 + 155);
    expect(totals.month_gbp).toBeCloseTo(6926.6);
    expect(totals.top_deal_id).toBe("d1");
    expect(totals.top_share).toBeCloseTo(23783.72 / 24282.72);
    expect(totals.skipped).toBe(1);
  });

  it("has no concentration without fees", () => {
    expect(fees([], new Set(), NOW)).toMatchObject({ ytd_gbp: 0, top_share: null, top_deal_id: null });
  });
});

describe("seller replies", () => {
  const conv = (id: string, created_at = "2026-10-01T00:00:00Z", buyer = "buyer-a") => ({ id, created_at, counterparty_account_id: buyer });
  const msg = (conversation_id: string, created_at: string, sender_account_id: string | null, is_system_seeded = false) =>
    ({ conversation_id, created_at, sender_account_id, is_system_seeded });

  it("buckets each buyer question into within 24 hours, later, never and still open", () => {
    const buckets = replyBuckets(rows({
      conversations: [
        conv("within"), conv("later"), conv("never"), conv("open"), conv("ours"),
        conv("seeded-only"), conv("before-aug", "2026-07-20T00:00:00Z"), conv("test", "2026-10-01T00:00:00Z", TEST_BUYER),
      ],
      messages: [
        // A system-seeded opener is not the question, and the seller's message before it is not a reply.
        msg("within", "2026-10-01T09:00:00Z", "seller", true),
        msg("within", "2026-10-01T10:00:00Z", "buyer-a"),
        msg("within", "2026-10-02T09:00:00Z", "seller"),
        msg("later", "2026-10-01T10:00:00Z", "buyer-a"),
        msg("later", "2026-10-01T12:00:00Z", "buyer-a"),
        msg("later", "2026-10-03T10:00:00Z", "seller"),
        msg("never", "2026-10-01T10:00:00Z", "buyer-a"),
        msg("never", "2026-10-02T10:00:00Z", "seller", true),
        // Asked 5 hours ago: open, not never.
        msg("open", "2026-10-22T10:00:00Z", "buyer-a"),
        // ReBattery answering counts as a reply.
        msg("ours", "2026-10-01T10:00:00Z", "buyer-a"),
        msg("ours", "2026-10-01T11:00:00Z", "rebattery"),
        msg("seeded-only", "2026-10-01T10:00:00Z", "buyer-a", true),
        msg("before-aug", "2026-07-20T10:00:00Z", "buyer-a"),
        msg("test", "2026-10-01T10:00:00Z", TEST_BUYER),
      ],
    }), "2026-08-01", NOW);
    expect(buckets).toEqual({ within: 2, later: 1, never: 1, open: 1 });
  });
});

describe("platformHome", () => {
  it("puts the marketplace numbers together", () => {
    const home = platformHome(rows({
      deals: [{ id: "d1", created_at: "2026-10-02T15:33:25Z", supplier_account_id: "pylon", counterparty_account_id: "buyer-a" }],
      payments: [pay({ deal_id: "d1", platform_fee_amount: 155 })],
      offers: [{ buyer_account_id: "buyer-b", created_at: "2026-10-20T00:00:00Z" }],
      accountNames: new Map([["pylon", "Pylon Technologies"]]),
    }), NOW, "2026-08-01");
    expect(home.paid_this_month).toBe(1);
    expect(home.last_paid_at).toBe("2026-10-02T15:33:27Z");
    expect(home.fees).toMatchObject({ ytd_gbp: 155, month_gbp: 155, top_share: 1, top_label: "Pylon Technologies", paid_deals_ytd: 1 });
    expect(home.since_deal).toMatchObject({ days: 19, enquiries_since: 1 });
    expect(home.overview.weeks.map((w) => w.week_start)).toEqual(weekRange("2026-10-19", 13));
    expect(home.overview.weeks.at(-1)).toEqual({ week_start: "2026-10-19", enquiries: 1, opened: 0, paid: 0, partial: true });
    expect(home.overview.weeks.find((w) => w.week_start === "2026-09-28")).toMatchObject({ opened: 1, paid: 1, partial: false });
    expect(home.overview).toMatchObject({ enquiries_30d: 1, opened_30d: 1, enquiry_blocks: [0, 0, 1], opened_blocks: [0, 0, 1] });
  });
});
