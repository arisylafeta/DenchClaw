import { describe, expect, it } from "vitest";
import type { SheetRow } from "./bulk-sheet";
import { ACTIVE_DEAL_LIMIT, daysInNew, dealWaiting, isActive, mentionsIn, openMentions, overdueByOwner, overLimit, STUCK_NEW_DAYS, stuckInNew, waitingLabel, type Mention } from "./bulk-today";
import { htmlToReadable, readableMail, sortHistory } from "./deal-history-core";

const row = (o: Partial<SheetRow> = {}): SheetRow => ({
  key: o.id ?? "r", id: o.id ?? "r", kind: "supply", side: "seller", title: o.id ?? "r", company: null, company_id: null, category: null,
  progress: "Qualified", tone: "new", score: null, latest: null, next_action: null, next_due: null, owner: "Alex", touched: null, ...o,
});
const now = new Date("2026-11-12T12:00:00Z");

describe("Stuck in New", () => {
  it("is a New listing more than 7 days old, longest first; 7 days exactly is not stuck yet", () => {
    expect(STUCK_NEW_DAYS).toBe(7);
    const rows = [
      row({ id: "eight", progress: "New", stage_since: "2026-11-04T11:00:00Z" }),
      row({ id: "seven", progress: "New", stage_since: "2026-11-05T12:00:00Z" }),
      row({ id: "twenty", progress: "New", stage_since: "2026-10-23T12:00:00Z" }),
      row({ id: "qualified", progress: "Qualified", stage_since: "2026-10-01T12:00:00Z" }),
      row({ id: "closed", progress: "New", closed: true, stage_since: "2026-10-01T12:00:00Z" }),
    ];
    expect(stuckInNew(rows, now).map((s) => [s.row.id, s.days])).toEqual([["twenty", 20], ["eight", 8]]);
    expect(daysInNew(rows[1], now)).toBe(7);
  });
});

describe("the active deal limit", () => {
  it("warns for an owner past 20 active deals, counting neither New nor finished deals", () => {
    expect(ACTIVE_DEAL_LIMIT).toBe(20);
    const many = (owner: string | null, n: number, o: Partial<SheetRow> = {}) => Array.from({ length: n }, (_, i) => row({ id: `${owner}-${i}-${o.progress ?? ""}${o.deal_stage ?? ""}`, owner, ...o }));
    const rows = [...many("Sean", 21), ...many("Alex", 20), ...many("Alex", 5, { progress: "New" }), ...many("Alex", 3, { deal_stage: "Delivered" }), ...many(null, 22, { progress: "Sourcing" })];
    expect(overLimit(rows)).toEqual([{ owner: "No owner", count: 22 }, { owner: "Sean", count: 21 }]);
    expect(isActive(row({ deal_stage: "Lost" }))).toBe(false);
    expect(isActive(row({ closed: true }))).toBe(false);
  });
});

describe("waiting on them or us", () => {
  it("reads the last real message, in working days", () => {
    // Ours went Monday 9 Nov after their Friday email: waiting on them for 3 working days by Thursday.
    const them = dealWaiting({ last_in_at: "2026-11-06T10:00:00Z", last_out_at: "2026-11-10T09:00:00Z", waiting_from: "2026-11-09T09:00:00Z" }, now);
    expect(them).toEqual({ on: "them", days: 3, since: "2026-11-09T09:00:00Z" });
    expect(waitingLabel(them!)).toBe("Waiting on them · 3 working days");
    expect(dealWaiting({ last_in_at: "2026-11-12T08:00:00Z", last_out_at: "2026-11-10T09:00:00Z", waiting_from: null }, now)).toEqual({ on: "us", days: 0, since: "2026-11-12T08:00:00Z" });
    expect(waitingLabel({ on: "us", days: 0, since: "" })).toBe("Waiting on us · today");
    expect(dealWaiting({ last_in_at: null, last_out_at: null, waiting_from: null }, now)).toBeNull();
  });
});

describe("overdue by owner", () => {
  it("groups in the order Sean, Alex, Ari, then No owner", () => {
    const groups = overdueByOwner([row({ id: "a", owner: "Ari" }), row({ id: "b", owner: null }), row({ id: "c", owner: "Alex" }), row({ id: "d", owner: "Ari" })]);
    expect(groups.map((g) => [g.owner, g.rows.map((r) => r.id)])).toEqual([["Alex", ["c"]], ["Ari", ["a", "d"]], ["No owner", ["b"]]]);
  });
});

describe("mentions", () => {
  it("finds @Alex, @Sean and @Ari in any case, once each, and nobody else", () => {
    expect(mentionsIn("@sean can you call? cc @Ari and @ari, not @bob or email@alex.com")).toEqual(["Sean", "Ari"]);
    expect(mentionsIn("No one here")).toEqual([]);
  });
  it("stay open for a person until they tick them", () => {
    const m = (id: string, mentions: string[], ticked: Record<string, string> = {}): Mention => ({ id, listing_id: "l", listing_title: "t", text: "x", by: null, at: "", mentions, ticked });
    expect(openMentions([m("1", ["Sean"]), m("2", ["Sean"], { Sean: "2026-11-12" }), m("3", ["Alex"])], "Sean").map((x) => x.id)).toEqual(["1"]);
  });
});

describe("one readable history", () => {
  it("keeps link words and addresses, drops markup and the quoted thread", () => {
    expect(htmlToReadable(`<div>Hi Dana,<br>See <a href="https://x.example/offer">the offer</a> and <a href="https://x.example">https://x.example</a>.</div><style>p{}</style>`))
      .toBe("Hi Dana,\nSee the offer (https://x.example/offer) and https://x.example.");
    expect(htmlToReadable(`<a href="https://x.example/o"><img src="logo.png"></a> &pound;40 &amp; more`)).toBe("https://x.example/o £40 & more");
    expect(readableMail("Thanks, 20 packs.\n\nOn Mon, 2 Nov 2026 at 09:00, Alex wrote:\n> Which?", null)).toBe("Thanks, 20 packs.");
    expect(readableMail("", "<p>Only <b>HTML</b></p>")).toBe("Only HTML");
    expect(readableMail("<html><body><p>Markup in the plain part</p></body></html>", null)).toBe("Markup in the plain part");
  });
  it("puts email and WhatsApp in one thread, oldest first", () => {
    const m = (id: string, channel: "mail" | "whatsapp", at: string) => ({ id, channel, direction: null, from: "", at, subject: null, text: "", href: null });
    expect(sortHistory([m("w1", "whatsapp", "2026-11-03T10:00:00Z"), m("m2", "mail", "2026-11-04T10:00:00Z"), m("m1", "mail", "2026-11-02T10:00:00Z")]).map((x) => x.id)).toEqual(["m1", "w1", "m2"]);
  });
});
