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
      { id: "l1", title: "Kia packs", seo_slug: "kia", supplier_account_id: "seller" },
      { id: "l2", title: "Test listing", seo_slug: null, supplier_account_id: TEST_SELLER },
    ],
    accountNames: new Map([["buyer", "Real Buyer"], ["staff", "Staff Buyer"], ["paid", "Paid Buyer"]]),
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
      offers: [{ created_at: "2026-09-21T10:00:00Z", status: "expired", buyer_account_id: "paid", listing_id: "l1", amount: 900, currency: "gbp", quantity_requested: 1 }],
      bids: [{ created_at: "2026-09-22T10:00:00Z", email: "ari.sylafeta@gmail.com", listing_id: "l1", submission_kind: "buy_now", price_per_kwh: null, amount_per_unit: 10, currency: "eur" }],
    }), "https://rebattery.io/");
    expect(list).toEqual([]);
  });

  it("groups a buyer's signals, folds their auction bid into their account, and puts the uncontacted first", () => {
    const list = assembleFollowUps(rows({
      deals: [deal({ id: "d1", status: "cancelled", workflow_step: "payment_pending", agreed_amount: 4490, agreed_currency: "eur" })],
      chats: [{ created_at: "2026-09-25T10:00:00Z", listing_id: "l1", supplier_account_id: "seller", counterparty_account_id: "buyer" }],
      bids: [
        { created_at: "2026-09-26T10:00:00Z", email: "PAT@buyer.example.org", listing_id: "l1", submission_kind: "offer", price_per_kwh: 15, amount_per_unit: null, currency: "eur" },
        { created_at: "2026-09-24T10:00:00Z", email: "lee@other.example.org", listing_id: "l1", submission_kind: "offer", price_per_kwh: 20, amount_per_unit: null, currency: "eur" },
      ],
      people: [
        { id: "p1", email: "pat@buyer.example.org", name: "Pat", last_contact: "2026-09-27T09:00:00Z" },
        { id: "p2", email: "lee@other.example.org", name: "Lee", last_contact: "2026-09-01T09:00:00Z" },
      ],
    }), "https://rebattery.io/");

    expect(list.map((f) => [f.name, f.contacted_since, f.more])).toEqual([["Lee", false, 0], ["Real Buyer", true, 2]]);
    expect(list[1]).toMatchObject({
      person_id: "p1",
      latest: { kind: "auction", text: "Auction offer EUR 15/kWh", listing_title: "Kia packs", listing_url: "https://rebattery.io/marketplace/kia" },
    });
  });
});
