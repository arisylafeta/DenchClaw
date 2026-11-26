import { describe, expect, it } from "vitest";
import { BANDS, dealValue, isAutomated, largeLot, matchName, mergeByPerson, rankItems, scoreSignals, signalsOf, waited, waitedLabel, type RankItem } from "./relay-rank-core";

// Friday 20 Nov 2026, 10:00 London.
const now = new Date("2026-11-20T10:00:00Z");

let n = 0;
const item = (over: Partial<RankItem> = {}): RankItem => ({
  id: `i${++n}`, status: "open", email: "someone@example.co.uk", name: "Some One", company: null, contactType: "buyer", situation: null, tab: "action",
  priority: "high", headline: "A question", waitingSince: "2026-11-19T09:00:00Z", lastAt: "2026-11-19T09:00:00Z", text: "",
  personIds: [], companyId: null, personal: false, deal: null, waitingInbound: ["2026-11-19T09:00:00Z"], firstContact: false,
  pastDeals: 0, customer: false, inboundEmails: 1, firstInboundAt: "2026-11-19T09:00:00Z", hasDraft: false, ...over,
});
const score = (items: RankItem[]) => scoreSignals(signalsOf(items, now), now);

describe("waited", () => {
  it("counts London calendar days and leaves weekends out of working days", () => {
    expect(waited("2026-11-13T15:00:00Z", now)).toEqual({ days: 7, workingDays: 5 });
    expect(waited("2026-11-20T08:00:00Z", now)).toEqual({ days: 0, workingDays: 0 });
    expect(waited("2026-11-14T12:00:00Z", now)).toEqual({ days: 6, workingDays: 5 });  // a Saturday email
    expect(waited(null, now)).toEqual({ days: 0, workingDays: 0 });
  });
  it("uses the London day, not the UTC one", () => {
    // 23:30 UTC on 19 Nov is still 19 Nov in London in winter; in summer it would be the 20th.
    expect(waited("2026-11-19T23:30:00Z", now).days).toBe(1);
    expect(waited("2026-07-19T23:30:00Z", new Date("2026-07-20T10:00:00Z")).days).toBe(0);
  });
  it("labels", () => {
    expect(waitedLabel(0)).toBe("today");
    expect(waitedLabel(7)).toBe("7 d");
  });
});

describe("largeLot", () => {
  it("finds bulk quantities", () => {
    expect(largeLot("We have 1,000 Samsung SDI modules")).toBe("1,000 modules");
    expect(largeLot("8.44 MWh of storage")).toBe("8.44 MWh");
    expect(largeLot("677,000 Panasonic 21700 cells")).toBe("677,000 cells");
    expect(largeLot("92-102 packs across 5 lines")).toBe("102 packs");
  });
  it("ignores small lots, prices, weights, part numbers and cell formats", () => {
    expect(largeLot("24 KORE modules")).toBeNull();
    expect(largeLot("€3,500 per battery")).toBeNull();
    expect(largeLot("a 370 kg battery")).toBeNull();
    expect(largeLot("18650 cells")).toBeNull();
    expect(largeLot("LR166066 modules")).toBeNull();
  });
});

describe("dealValue", () => {
  it("reads a range by its lower bound and keeps a short label", () => {
    expect(dealValue("€40–60k")).toEqual({ gbp: 40_000 * 0.87, label: "€40–60k" });
    expect(dealValue("$516,800")?.label).toBe("$517k");
    expect(dealValue("80k (Raul, full batch)")).toEqual({ gbp: 80_000, label: "£80k" });
    expect(dealValue("€2,975,000 net seller ask for 85,000 cells")?.label).toBe("€3m");
  });
  it("is null without an amount", () => {
    expect(dealValue(null)).toBeNull();
    expect(dealValue("2 containers")).toBeNull();
  });
});

describe("isAutomated", () => {
  it("knows machine senders", () => {
    expect(isAutomated("novabook@notifications.novabook.com")).toBe(true);
    expect(isAutomated("no-reply@example.com")).toBe(true);
    expect(isAutomated("notifications+abc@github.com")).toBe(true);
    expect(isAutomated("info@boelsautodemontage.nl")).toBe(false);
    expect(isAutomated("ben@silentclassics.co.uk")).toBe(false);
  });
});

describe("matchName", () => {
  it("keeps real full names only", () => {
    expect(matchName("Ben Bament", "ben@silentclassics.co.uk")).toBe("ben bament");
    expect(matchName("Vojtěch Lubomír", null)).toBe("vojtech lubomir");
    expect(matchName("Qasimdk1", "qasimdk1@gmail.com")).toBeNull();
    expect(matchName("Info [Deijne.nl]", "info@deijne.nl")).toBeNull();
    expect(matchName("Client Services", "client.services@office-serv.co.uk")).toBeNull();
    expect(matchName("Ben Bament", "benbament@gmail.com")).toBeNull();  // made from the address, so it proves nothing
  });
});

describe("mergeByPerson", () => {
  const ids = (groups: RankItem[][]) => groups.map((g) => g.map((i) => i.id).sort()).sort();
  it("joins the same address and the same CRM person", () => {
    const a = item({ id: "a", email: "qasimdk1@gmail.com", name: "Qasimdk1", personal: true });
    const b = item({ id: "b", email: "qasimdk1@gmail.com", name: "Qasimdk1", personal: true });
    const c = item({ id: "c", email: "old@acme.com", personIds: ["p1"] });
    const d = item({ id: "d", email: "new@acme.com", personIds: ["p1"] });
    expect(ids(mergeByPerson([a, b, c, d]))).toEqual([["a", "b"], ["c", "d"]]);
  });
  it("joins a personal address to a work address with the same full name", () => {
    const gmail = item({ id: "g", email: "bbament@gmail.com", name: "Ben Bament", personal: true, personIds: ["p1"] });
    const work = item({ id: "w", email: "ben@silentclassics.co.uk", name: "Ben Bament", companyId: "sc", personIds: ["p2"] });
    expect(ids(mergeByPerson([gmail, work]))).toEqual([["g", "w"]]);
  });
  it("never joins two people at one company, or one name at two companies", () => {
    const kevin = item({ id: "k", email: "kevin@deijne.nl", name: "Kevin van Deijne", companyId: "dj" });
    const info = item({ id: "i", email: "info@deijne.nl", name: "Info [Deijne.nl]", companyId: "dj" });
    const benA = item({ id: "a", email: "ben@one.com", name: "Ben Smith", companyId: "one" });
    const benB = item({ id: "b", email: "ben@two.com", name: "Ben Smith", companyId: "two" });
    const benC = item({ id: "c", email: "ben@three.com", name: "Ben Smith" });  // no CRM company: its domain stands in
    expect(ids(mergeByPerson([kevin, info, benA, benB, benC]))).toEqual([["a"], ["b"], ["c"], ["i"], ["k"]]);
  });
  it("does not chain two companies through one personal address", () => {
    const gmail = item({ id: "g", email: "bsmith@gmail.com", name: "Ben Smith", personal: true });
    const one = item({ id: "a", email: "ben@one.com", name: "Ben Smith", companyId: "one" });
    const two = item({ id: "b", email: "ben@two.com", name: "Ben Smith", companyId: "two" });
    expect(ids(mergeByPerson([gmail, one, two]))).toEqual([["a", "g"], ["b"]]);
  });
});

describe("score", () => {
  it("puts a returning buyer who chased in Now", () => {
    const first = item({ email: "bbament@gmail.com", name: "Ben Bament", personal: true, situation: "buyer_price", waitingSince: "2026-11-13T15:00:00Z",
      lastAt: "2026-11-13T15:00:00Z", waitingInbound: ["2026-11-13T15:00:00Z"] });
    const chase = item({ email: "ben@silentclassics.co.uk", name: "Ben Bament", companyId: "sc", situation: "buyer_price", pastDeals: 2, customer: true,
      waitingSince: "2026-11-20T08:00:00Z", lastAt: "2026-11-20T08:00:00Z", waitingInbound: ["2026-11-20T08:00:00Z"], inboundEmails: 15, firstInboundAt: "2025-07-16T09:00:00Z" });
    const [row] = rankItems([first, chase], now);
    expect(row.band).toBe("now");
    expect(row.tag).toBe("Returning");
    expect(row.itemIds).toHaveLength(2);
    expect(row.openId).toBe(chase.id);
    expect(row.waited).toBe("7 d");
    expect(row.emails).toBe(2);
    expect(row.why.join(" ")).toMatch(/returning: 2 past deals.*they chased/);
  });
  it("leads with an overdue promise", () => {
    const s = score([item({ priority: "overdue", situation: "buyer_price" })]);
    expect(s.tag).toBe("Promise overdue");
    expect(s.score).toBeGreaterThanOrEqual(BANDS[0][1]);
  });
  it("shows the live deal and its value", () => {
    const s = score([item({ contactType: "supplier", deal: { live: true, value: "€40–60k", quantity: "40 packs" } })]);
    expect(s.tag).toBe("Live deal €40–60k");
    expect(score([item({ deal: { live: false, value: "€40–60k", quantity: null } })]).tag).toBeNull();
  });
  it("names a new buyer or seller", () => {
    expect(score([item({ firstContact: true, situation: "buyer_price" })]).tag).toBe("New buyer");
    expect(score([item({ firstContact: true, contactType: "supplier", situation: "supplier_offer" })]).tag).toBe("New seller");
    expect(score([item({ firstContact: true, contactType: "partner" })]).tag).toBeNull();
  });
  it("counts a chase only on a later day", () => {
    const sameDay = signalsOf([item({ waitingInbound: ["2026-11-12T09:00:00Z", "2026-11-12T11:00:00Z", "2026-11-12T15:00:00Z"] })], now);
    const nextDay = signalsOf([item({ waitingInbound: ["2026-11-12T09:00:00Z", "2026-11-16T11:00:00Z"] })], now);
    expect(sameDay.chases).toBe(0);
    expect(nextDay.chases).toBe(1);
  });
  it("grows with working days, then flattens", () => {
    const at = (since: string) => score([item({ situation: "buyer_price", waitingSince: since })]).score;
    expect(at("2026-11-13T09:00:00Z")).toBeGreaterThan(at("2026-11-19T09:00:00Z"));
    expect(at("2026-09-01T09:00:00Z")).toBe(at("2026-10-01T09:00:00Z"));
  });
  it("keeps automated mail, admin and the other tab out of Now and Today, however long they wait", () => {
    const old = { waitingSince: "2026-09-01T09:00:00Z", waitingInbound: ["2026-09-01T09:00:00Z", "2026-09-02T09:00:00Z"], inboundEmails: 40, firstInboundAt: "2025-01-01T00:00:00Z" };
    for (const over of [
      { email: "novabook@notifications.novabook.com", contactType: "admin" },
      { contactType: "admin", situation: "admin" },
      { contactType: "supplier", situation: "admin" },
      { tab: "other" as const },
    ]) {
      const s = score([item({ ...old, ...over })]);
      expect(["week", "later"]).toContain(s.band);
      expect(s.tag).toBeNull();
    }
  });
  it("counts a deadline only while the email is fresh", () => {
    expect(score([item({ priority: "urgent", contactType: "supplier", waitingSince: "2026-11-20T08:00:00Z" })]).tag).toBe("Deadline");
    expect(score([item({ priority: "urgent", contactType: "supplier", waitingSince: "2026-11-12T08:00:00Z" })]).why.join()).not.toMatch(/deadline/);
  });
  it("says draft ready when an unsent draft waits", () => {
    expect(score([item({ hasDraft: true })]).tag).toBe("Draft ready");
  });
  it("takes Draft ready from the person's email in Review, and opens their newest open email", () => {
    const open = item({ id: "o", email: "bbament@gmail.com", name: "Ben Bament", personal: true });
    const inReview = item({ id: "r", status: "review", email: "ben@silentclassics.co.uk", name: "Ben Bament", companyId: "sc", hasDraft: true });
    const rows = rankItems([open, inReview], now);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ itemIds: ["o"], reviewIds: ["r"], openId: "o", hasDraft: true, tag: "Draft ready" });
  });
  it("keeps a row for someone whose only email has a draft waiting: it is still on Alex until it goes", () => {
    const alone = item({ id: "x", status: "review", email: "x@other.com", name: "Xavier Other", hasDraft: true });
    const rows = rankItems([alone], now);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ itemIds: ["x"], reviewIds: ["x"], openId: "x", hasDraft: true, tag: "Draft ready" });
  });
  it("adds no stake for a deal that is off: not live in the CRM, or called off in their email", () => {
    const deal = { live: true, value: "$516,800", quantity: "680,000 cells" };
    expect(score([item({ contactType: "supplier", deal })]).tag).toBe("Live deal $517k");
    const off = score([item({ contactType: "supplier", situation: "decline", deal })]);
    expect(off.why.join()).not.toMatch(/live deal|large lot/);
    const closed = score([item({ contactType: "supplier", deal: { ...deal, live: false } })]);
    expect(closed.why.join()).not.toMatch(/live deal|large lot/);
  });
  it("orders rows best first and gives each its band", () => {
    const rows = rankItems([
      item({ id: "low", email: "a@x.com", name: "A Person", contactType: "partner" }),
      item({ id: "high", email: "b@y.com", name: "B Person", priority: "overdue", situation: "buyer_price" }),
    ], now);
    expect(rows.map((r) => r.openId)).toEqual(["high", "low"]);
    for (const r of rows) expect(r.band).toBe(BANDS.find(([, min]) => r.score >= min)?.[0] ?? "later");
  });
});

describe("scheduled replies", () => {
  it("puts a person whose every email has a scheduled reply in Scheduled, and back once they write again", () => {
    const waiting = item({ id: "r", status: "review", hasDraft: true, scheduledAt: "2026-11-23T08:00:00Z" });
    expect(rankItems([waiting], now)[0].scheduledAt).toBe("2026-11-23T08:00:00Z");
    const wroteAgain = item({ id: "o", lastAt: "2026-11-22T09:00:00Z" });
    expect(rankItems([waiting, wroteAgain], now)[0].scheduledAt).toBeNull();
    expect(rankItems([item({ id: "x", status: "review", hasDraft: true })], now)[0].scheduledAt).toBeNull();
  });
});


describe("nobody replied", () => {
  it("puts an email nobody answered in time at the top, with its own cue, even when it was set aside", () => {
    const s = score([item({ overdueSince: "2026-11-13T16:37:00Z", contactType: "supplier" })]);
    expect(s.band).toBe("now");
    expect(s.tag).toBe("Overdue: nobody replied");
    expect(score([item({ tab: "other" })]).tag).toBeNull();
  });
});
