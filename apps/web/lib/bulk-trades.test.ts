import { describe, expect, it } from "vitest";
import {
  dueLabel,
  groupTrades,
  parseTradePatch,
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
