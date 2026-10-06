import { describe, expect, it } from "vitest";
import { assembleFollowUps, type FollowUpRows } from "./marketplace-pulse-follow-ups";

// A test seller from marketplace-pulse-exclusions.json.
const TEST_SELLER = "97052761-e067-4b33-b8bf-cbac46e7f9d2";

const deal = (o: Partial<FollowUpRows["deals"][number]>): FollowUpRows["deals"][number] => ({
  id: "d", status: "open", workflow_step: "accepted", created_at: "2026-09-20T10:00:00Z", listing_id: "l1",
  supplier_account_id: "seller", counterparty_account_id: "buyer", agreed_amount: 1000, agreed_currency: "gbp", ...o,
});

function rows(o: Partial<FollowUpRows>): FollowUpRows {
  return {
    deals: [], payments: [], offers: [], chats: [], bids: [],
    listings: [
      { id: "l1", title: "Kia packs", seo_slug: "kia", supplier_account_id: "seller", specs: { chemistry: "NMC", format: "Pack", manufacturer: "Kia", pack_kwh: 64 } },
      { id: "l2", title: "Test listing", seo_slug: null, supplier_account_id: TEST_SELLER, specs: null },
    ],
    live: [
      { id: "l3", title: "Hyundai packs", seo_slug: "hyundai", supplier_account_id: "seller", created_at: "2026-09-01", specs: { chemistry: "nmc", format: "pack", manufacturer: "Hyundai", pack_kwh: 38 } },
      { id: "l7", title: "Megapack", seo_slug: "mega", supplier_account_id: "seller", created_at: "2026-09-05", specs: { chemistry: "NMC", format: "Pack", manufacturer: "Tesla", pack_kwh: 2500 } },
      { id: "l4", title: "Kia packs B", seo_slug: "kia-b", supplier_account_id: "seller", created_at: "2026-08-01", specs: { chemistry: "NMC", format: "Pack", manufacturer: "KIA", pack_kwh: 77 } },
      { id: "l5", title: "LFP cells", seo_slug: "lfp", supplier_account_id: "seller", created_at: "2026-09-02", specs: { chemistry: "LFP", format: "Cell", manufacturer: "CATL" } },
      { id: "l6", title: "Test Kia", seo_slug: "t", supplier_account_id: TEST_SELLER, created_at: "2026-09-03", specs: { chemistry: "NMC", format: "Pack", manufacturer: "Kia" } },
    ],
    accountNames: new Map([["buyer", "Real Buyer"], ["staff", "Staff Buyer"], ["paid", "Paid Buyer"], ["seller", "Seller Ltd"]]),
    accountEmails: new Map([["buyer", ["pat@buyer.example.org"]], ["staff", ["ari@rebattery.io"]], ["paid", ["sam@paid.example.org"]]]),
    people: [],
    ...o,
  };
}

describe("assembleFollowUps", () => {
  it("leaves out staff buyers, test sellers' listings, and listings the buyer paid for", () => {
    const list = assembleFollowUps(rows({
      deals: [
        deal({ id: "d1", counterparty_account_id: "staff" }),
        deal({ id: "d2", listing_id: "l2" }),
        deal({ id: "d3", counterparty_account_id: "paid" }),
      ],
      payments: [{ deal_id: "d3" }],
      offers: [{ created_at: "2026-09-21T10:00:00Z", status: "expired", buyer_account_id: "paid", listing_id: "l1", amount: 900, currency: "gbp", quantity_requested: 1, expires_at: null }],
      bids: [{ created_at: "2026-09-22T10:00:00Z", email: "ari.sylafeta@gmail.com", listing_id: "l1", submission_kind: "buy_now", price_per_kwh: null, amount_per_unit: 10, currency: "eur" }],
    }), "https://rebattery.io/");
    expect(list).toEqual({ followUps: [], waiting: [] });
  });

  it("groups a buyer's signals, folds their auction bid into their account, and puts the uncontacted first", () => {
    const { followUps: list } = assembleFollowUps(rows({
      deals: [deal({ id: "d1", status: "cancelled", workflow_step: "payment_pending", agreed_amount: 4490, agreed_currency: "eur" })],
      chats: [{ created_at: "2026-09-25T10:00:00Z", listing_id: "l1", supplier_account_id: "seller", counterparty_account_id: "buyer" }],
      bids: [
        { created_at: "2026-09-26T10:00:00Z", email: "PAT@buyer.example.org", listing_id: "l1", submission_kind: "offer", price_per_kwh: 15, amount_per_unit: null, currency: "eur" },
        { created_at: "2026-09-24T10:00:00Z", email: "lee@other.example.org", listing_id: "l1", submission_kind: "offer", price_per_kwh: 20, amount_per_unit: null, currency: "eur" },
      ],
      people: [
        { id: "p1", email: "pat@buyer.example.org", name: "Pat", first_name: "Pat", last_contact: "2026-09-27T09:00:00Z", subscribed: true },
        { id: "p2", email: "lee@other.example.org", name: "Lee", first_name: "Lee", last_contact: "2026-09-01T09:00:00Z", subscribed: false },
      ],
    }), "https://rebattery.io/");

    expect(list.map((f) => [f.name, f.contacted_since, f.more])).toEqual([["Lee", false, 0], ["Real Buyer", true, 2]]);
    expect(list[1]).toMatchObject({
      person_id: "p1",
      first_name: "Pat",
      subscribed: true,
      latest: { kind: "auction", text: "Auction offer EUR 15/kWh", listing_title: "Kia packs", listing_url: "https://rebattery.io/marketplace/kia" },
    });
    // Same chemistry, format and rough size, same maker first, never a test seller's listing.
    expect(list[1].similar).toEqual([
      { title: "Kia packs B", url: "https://rebattery.io/marketplace/kia-b" },
      { title: "Hyundai packs", url: "https://rebattery.io/marketplace/hyundai" },
    ]);
  });

  it("lists unanswered offers and deals unpaid for two days as waiting on us, not as follow-ups", () => {
    const { followUps, waiting } = assembleFollowUps(rows({
      deals: [
        deal({ id: "d1", workflow_step: "payment_pending", created_at: "2026-10-01T10:00:00Z" }),
        deal({ id: "d2", workflow_step: "accepted", created_at: "2026-10-05T20:00:00Z" }),
      ],
      offers: [
        { created_at: "2026-10-03T10:00:00Z", status: "submitted", buyer_account_id: "buyer", listing_id: "l1", amount: 900, currency: "gbp", quantity_requested: 2, expires_at: "2026-10-10T10:00:00Z" },
        { created_at: "2026-10-03T10:00:00Z", status: "submitted", buyer_account_id: "staff", listing_id: "l1", amount: 1, currency: "gbp", quantity_requested: 1, expires_at: "2026-10-09T10:00:00Z" },
      ],
    }), "https://rebattery.io", new Date("2026-10-06T12:00:00Z"));

    expect(waiting).toEqual([
      expect.objectContaining({ kind: "offer", text: "Offer GBP 900 × 2", buyer: "Real Buyer", seller: "Seller Ltd", expires_at: "2026-10-10T10:00:00Z" }),
      expect.objectContaining({ kind: "deal", text: "Deal payment pending GBP 1,000", buyer: "Real Buyer", listing_title: "Kia packs" }),
    ]);
    expect(followUps).toHaveLength(1);
    expect(followUps[0].latest.kind).toBe("deal");
    expect(followUps[0].more).toBe(1);
  });
});
