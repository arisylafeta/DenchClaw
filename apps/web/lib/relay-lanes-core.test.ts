import { describe, expect, it } from "vitest";
import { oldestLead, sortLanes, verifySuggest, waited, leadTitle } from "./relay-lanes-core";

// A made-up thread in the shape of the real ones.
const TEXT = `From maria@example.test, 2026-11-06:
Hi Alex, we have 14 Pylontech US3000C units to return under the scheme. Can you submit the claim and arrange collection as soon as possible?`;

describe("verifySuggest", () => {
  it("keeps answers the emails back, in order, with what Alex has to add", () => {
    const got = verifySuggest({
      ask: "Submit the returns claim and book collection",
      answers: [
        { label: "Yes, submitting today.", note: "Say the claim for the 14 units goes in today and collection is being arranged.", fill: null },
        { label: "Give a collection date", note: "Confirm the claim is in and give the collection date.", fill: "the collection date" },
        { label: "Ask for serial numbers", note: "Ask for the serial numbers of the 14 units before submitting the claim.", fill: "null" },
      ],
    }, TEXT);
    expect(got.ask).toBe("Submit the returns claim and book collection");
    expect(got.answers.map((a) => a.label)).toEqual(["Yes, submitting today", "Give a collection date", "Ask for serial numbers"]);
    expect(got.answers.map((a) => a.fill)).toEqual([null, "the collection date", null]);
  });

  it("drops an answer with a number or a price that is not in the emails", () => {
    const got = verifySuggest({
      ask: "x",
      answers: [
        { label: "Collect on 21 November", note: "Say collection is booked for 21 November.", fill: null },
        { label: "Offer a credit", note: "Offer a £50 credit for the delay on the units.", fill: null },
        { label: "Offer in euros", note: "Offer a credit in EUR for the delay on the units.", fill: null },
        { label: "Confirm the 14 units", note: "Confirm all 14 units are on the claim.", fill: null },
      ],
    }, TEXT);
    expect(got.answers.map((a) => a.label)).toEqual(["Confirm the 14 units"]);
  });

  it("drops a price in words and a figure hidden in what Alex has to add", () => {
    const got = verifySuggest({
      answers: [
        { label: "Offer a price", note: "Offer two hundred pounds for each unit.", fill: null },
        { label: "Accept their rate", note: "Say the rate per kWh they asked for is fine.", fill: null },
        { label: "Give the price", note: "Say what we can pay for the units.", fill: "£45/kWh as agreed" },
        { label: "Give a price", note: "Say what we can pay for the units.", fill: "the price for each unit" },
      ],
    }, TEXT);
    expect(got.answers).toEqual([{ label: "Give a price", note: "Say what we can pay for the units.", fill: "the price for each unit" }]);
  });

  it("tells a reader's \"no reply needed\" from answers that did not survive", () => {
    expect(verifySuggest({ ask: null, answers: [] }, TEXT).quiet).toBe(true);
    expect(verifySuggest({ ask: "x", answers: [{ label: "Offer a credit", note: "Offer a £50 credit for the delay.", fill: null }] }, TEXT)).toEqual({ ask: "x", answers: [], quiet: false });
  });

  it("drops repeats, over-long text and anything that is not an answer, and keeps four at most", () => {
    const ok = (label: string) => ({ label, note: "Say this plainly in the reply.", fill: null });
    const got = verifySuggest({
      answers: [ok("Yes"), ok("yes"), ok("x".repeat(49)), { label: "No note", note: "short" }, null, "text", ok("No"), ok("Not yet"), ok("Ask for photos"), ok("Decline")],
    }, TEXT);
    expect(got.answers.map((a) => a.label)).toEqual(["Yes", "No", "Not yet", "Ask for photos"]);
    expect(got.ask).toBeNull();
  });

  it("reads nothing out of a reply that is not the expected shape", () => {
    expect(verifySuggest(null, TEXT)).toEqual({ ask: null, answers: [], quiet: false });
    expect(verifySuggest({ ask: "null", answers: "none" }, TEXT)).toEqual({ ask: null, answers: [], quiet: false });
  });
});

describe("sortLanes", () => {
  const item = (id: string, deal: string | null = null) => ({ id, bulk_listing_id: deal });
  const card = (item_id: string, status: string, at: string) => ({ item_id, status, who: { at } });

  it("puts a lead card's email in the leads lane only, oldest first", () => {
    const lanes = sortLanes(
      [item("a"), item("b", "deal-1"), item("c"), item("d", "deal-2"), item("e")],
      [card("c", "ready", "2026-11-10T09:00:00Z"), card("d", "preparing", "2026-11-09T09:00:00Z"), card("e", "failed", "2026-11-10T11:00:00Z")]);
    expect(lanes.leads.map((c) => c.item_id)).toEqual(["d", "c", "e"]);
    expect(lanes.deals.map((i) => i.id)).toEqual(["b"]);
    expect(lanes.replies.map((i) => i.id)).toEqual(["a"]);
  });

  it("leaves out a card whose email is no longer waiting, and keeps the order the emails came in", () => {
    const lanes = sortLanes([item("z"), item("a"), item("m", "deal")], [card("gone", "ready", "2026-11-10T09:00:00Z")]);
    expect(lanes.leads).toEqual([]);
    expect(lanes.replies.map((i) => i.id)).toEqual(["z", "a"]);
    expect(lanes.deals.map((i) => i.id)).toEqual(["m"]);
  });
});

describe("waited and oldestLead", () => {
  const now = Date.parse("2026-11-10T12:00:00Z");
  it("writes minutes, hours and days", () => {
    expect(waited("2026-11-10T11:15:00Z", now)).toBe("45 min");
    expect(waited("2026-11-09T14:00:00Z", now)).toBe("22 h");
    expect(waited("2026-11-05T12:00:00Z", now)).toBe("5 d");
    expect(waited(null, now)).toBe("");
    expect(waited("not a date", now)).toBe("");
  });
  it("finds the lead that has waited longest and says when it is past two hours", () => {
    const cards = [{ item_id: "a", status: "ready", who: { at: "2026-11-10T11:30:00Z" } }, { item_id: "b", status: "ready", who: { at: "2026-11-09T14:00:00Z" } }];
    expect(oldestLead(cards, now)).toEqual({ waited: "22 h", late: true });
    expect(oldestLead(cards.slice(0, 1), now)).toEqual({ waited: "30 min", late: false });
    expect(oldestLead([], now)).toBeNull();
  });
});

describe("leadTitle", () => {
  const facts = [{ key: "what", value: "Example LFP modules" }, { key: "how_many", value: "400 modules" }, { key: "where", value: "Leeds, UK" }, { key: "condition", value: "Used, working" }];
  it("writes what, how many and where, and leaves the other facts for the chips", () => {
    expect(leadTitle(facts, "A seller with modules.")).toEqual({ title: "Example LFP modules · 400 modules · Leeds, UK", rest: [facts[3]] });
  });
  it("keeps the summary when the email says too little", () => {
    expect(leadTitle([facts[0]], "A buyer asking what is available.")).toEqual({ title: "A buyer asking what is available.", rest: [facts[0]] });
    expect(leadTitle([], "A buyer asking what is available.").title).toBe("A buyer asking what is available.");
  });
});
