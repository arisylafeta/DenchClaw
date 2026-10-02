import { describe, expect, it } from "vitest";
import {
  dueLabel,
  groupTrades,
  dueText,
  heldTrades,
  holdLabel,
  parseTradePatch,
  stageTotal,
  todayInLondon,
  touchedLabel,
  type BulkTrade,
} from "./bulk-trades";

const TODAY = "2026-09-28";

function trade(overrides: Partial<BulkTrade>): BulkTrade {
  return {
    id: overrides.title ?? "t",
    title: "Trade",
    trade_stage: "With buyers",
    trade_kind: null,
    fact_line: null,
    next_step: "Do the thing",
    next_step_due: TODAY,
    next_step_contact_id: null,
    next_step_buyer_id: null,
    waiting_on: "us",
    waiting_since: null,
    owner_user_id: null,
    owner_name: null,
    value: null,
    last_touched: null,
    clear_by: null,
    ship_by: null,
    transport_class: null,
    tfs_needed: "unknown",
    listing_id: null,
    auction_slug: null,
    auction_status: null,
    auction_closes_at: null,
    hold_until: null,
    hold_reason: null,
    hold_from_stage: null,
    updated_at: "2026-09-28T09:00:00Z",
    ...overrides,
  };
}

describe("groupTrades", () => {
  it("puts live trades into the five list groups in order", () => {
    const groups = groupTrades([
      trade({ title: "Later", next_step_due: "2026-10-02" }),
      trade({ title: "Waiting", waiting_on: "them", waiting_since: "2026-09-22", next_step_due: "2026-09-30" }),
      trade({ title: "No date", next_step_due: null }),
      trade({ title: "No step", next_step: null, next_step_due: null }),
      trade({ title: "Today" }),
      trade({ title: "Late", next_step_due: "2026-09-25" }),
      trade({ title: "Chase", waiting_on: "them", next_step_due: "2026-09-27" }),
      trade({ title: "Won", trade_stage: "Done", next_step_due: "2026-09-01" }),
      trade({ title: "Gone", trade_stage: "Lost" }),
    ], TODAY);

    expect(groups.map((group) => [group.name, group.trades.map((t) => t.title)])).toEqual([
      ["Overdue", ["Late", "Chase"]],
      ["Due today", ["Today"]],
      ["No next step", ["No date", "No step"]],
      ["Waiting on them", ["Waiting"]],
      ["Later", ["Later"]],
    ]);
  });

  it("omits empty groups", () => {
    expect(groupTrades([trade({ title: "Today" })], TODAY).map((group) => group.name)).toEqual(["Due today"]);
  });
});

describe("labels", () => {
  it("formats due dates the way the list shows them", () => {
    expect(dueLabel(trade({ next_step_due: "2026-09-25" }), TODAY)).toBe("3d late");
    expect(dueLabel(trade({}), TODAY)).toBe("Today");
    expect(dueLabel(trade({ next_step_due: "2026-10-02" }), TODAY)).toBe("2 Oct");
    expect(dueLabel(trade({ next_step_due: null }), TODAY)).toBe("No date");
    expect(dueLabel(trade({ next_step: null, next_step_due: null }), TODAY)).toBe("None");
    expect(dueLabel(trade({ waiting_on: "them", waiting_since: "2026-09-22", next_step_due: "2026-09-30" }), TODAY))
      .toBe("since 22 Sep");
  });

  it("formats last touched as days ago", () => {
    expect(touchedLabel(trade({ last_touched: TODAY }), TODAY)).toBe("Today");
    expect(touchedLabel(trade({ last_touched: "2026-09-23" }), TODAY)).toBe("5d");
    expect(touchedLabel(trade({}), TODAY)).toBe("");
  });

  it("uses the UK date, not UTC", () => {
    expect(todayInLondon(new Date("2026-09-28T23:30:00Z"))).toBe("2026-09-29");
  });
});

describe("parseTradePatch", () => {
  it("trims text and clears empty optional fields", () => {
    expect(parseTradePatch({ next_step: "  Call Fabio ", value: "", next_step_due: "" })).toEqual({
      patch: { next_step: "Call Fabio", value: null, next_step_due: null },
    });
  });

  it("rejects unknown fields, bad enums and impossible dates", () => {
    expect(parseTradePatch({ stage: "Completed" })).toEqual({ error: "Unknown field: stage" });
    expect(parseTradePatch({ trade_stage: "Won" })).toEqual({ error: "Unknown stage." });
    expect(parseTradePatch({ next_step_due: "2026-02-30" })).toEqual({ error: "next_step_due must be a YYYY-MM-DD date." });
    expect(parseTradePatch({ title: "  " })).toEqual({ error: "title is required." });
    expect(parseTradePatch({ owner_user_id: "Alex" })).toEqual({ error: "owner_user_id must be a user id." });
  });
});

describe("stageTotal", () => {
  const withValue = (value: string | null) => trade({ value });

  it("adds ranges and single amounts in one currency", () => {
    expect(stageTotal([withValue("€119–149k"), withValue("€276–345k")])).toBe("€395–494k");
    expect(stageTotal([withValue("$500–600k")])).toBe("$500–600k");
    expect(stageTotal([withValue("€20k"), withValue("€12.5k")])).toBe("€32.5k");
  });

  it("marks a partial total when some values cannot be added", () => {
    expect(stageTotal([withValue("€119–149k"), withValue("[fee]"), withValue("€38.50/cell"), withValue(null)]))
      .toBe("€119–149k+");
  });

  it("shows nothing when no value adds up or currencies are mixed", () => {
    expect(stageTotal([withValue("[value]"), withValue("$450k floor")])).toBe("");
    expect(stageTotal([withValue("€100k"), withValue("$200k")])).toBe("");
    expect(stageTotal([])).toBe("");
  });

describe("next step", () => {
  it("says when it is due in words", () => {
    expect(dueText(trade({ next_step_due: "2026-09-25" }), TODAY)).toEqual({ text: "3 days late", tone: "red" });
    expect(dueText(trade({ next_step_due: "2026-09-27" }), TODAY)).toEqual({ text: "1 day late", tone: "red" });
    expect(dueText(trade({ next_step_due: TODAY }), TODAY)).toEqual({ text: "Due today", tone: "amber" });
    expect(dueText(trade({ next_step_due: "2026-09-29" }), TODAY)).toEqual({ text: "Due tomorrow", tone: "grey" });
    expect(dueText(trade({ next_step_due: "2026-10-02" }), TODAY)).toEqual({ text: "Due 2 Oct", tone: "grey" });
    expect(dueText(trade({ next_step_due: null }), TODAY)).toEqual({ text: "No due date", tone: "amber" });
    expect(dueText(trade({ waiting_on: "them", waiting_since: "2026-09-22", next_step_due: null }), TODAY).text)
      .toBe("Waiting on them since 22 Sep");
  });

  it("accepts one person per step, by id prefix", () => {
    const contact = "btc_11111111-1111-4111-8111-111111111111";
    const buyer = "btb_11111111-1111-4111-8111-111111111111";
    expect(parseTradePatch({ next_step_contact_id: contact })).toEqual({ patch: { next_step_contact_id: contact } });
    expect(parseTradePatch({ next_step_buyer_id: "" })).toEqual({ patch: { next_step_buyer_id: null } });
    expect(parseTradePatch({ next_step_contact_id: buyer })).toHaveProperty("error");
    expect(parseTradePatch({ next_step_contact_id: contact, next_step_buyer_id: buyer })).toHaveProperty("error");
  });
});
});

describe("on hold", () => {
  it("needs a resume date and a reason to go on hold", () => {
    expect(parseTradePatch({ trade_stage: "On hold" })).toEqual({ error: "Putting a trade on hold needs a resume date and a reason." });
    expect(parseTradePatch({ trade_stage: "On hold", hold_until: "2027-03-01", hold_reason: " Batteries on site " })).toEqual({
      patch: { trade_stage: "On hold", hold_until: "2027-03-01", hold_reason: "Batteries on site" },
    });
    expect(parseTradePatch({ hold_until: "not a date" })).toEqual({ error: "hold_until must be a YYYY-MM-DD date." });
  });

  it("keeps held trades out of the live groups and splits ended holds from waiting ones", () => {
    const opium = trade({ title: "Opium", trade_stage: "On hold", hold_until: "2027-03-01", hold_reason: "On site" });
    const ended = trade({ title: "Ended", trade_stage: "On hold", hold_until: "2026-09-20", hold_reason: "Wait" });
    const live = trade({ title: "Live" });
    expect(groupTrades([opium, ended, live], TODAY).flatMap((group) => group.trades.map((t) => t.title))).toEqual(["Live"]);
    const held = heldTrades([opium, ended, live], TODAY);
    expect(held.ended.map((t) => t.title)).toEqual(["Ended"]);
    expect(held.waiting.map((t) => t.title)).toEqual(["Opium"]);
  });

  it("labels the hold by its date", () => {
    expect(holdLabel({ hold_until: "2027-03-01" }, TODAY)).toBe("Until 1 Mar 2027");
    expect(holdLabel({ hold_until: "2026-11-02" }, TODAY)).toBe("Until 2 Nov");
    expect(holdLabel({ hold_until: TODAY }, TODAY)).toBe("Hold ends today");
    expect(holdLabel({ hold_until: "2026-09-25" }, TODAY)).toBe("Hold ended 3d ago");
  });
});
