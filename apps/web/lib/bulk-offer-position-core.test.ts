import { describe, expect, it } from "vitest";
import { cleanMessage, isAutoReply, ladder, money, nextStep, priceLine, priceMoves, promiseIn, stageHint, whoseMove, type PositionMessage } from "./bulk-offer-position-core";

// Thursday 12 Nov 2026, midday in London.
const NOW = new Date("2026-11-12T12:00:00Z");
const msg = (id: string, direction: "inbound" | "outbound", at: string, text: string, over: Partial<PositionMessage> = {}): PositionMessage =>
  ({ id, channel: "mail", direction, at, subject: "Packs", text, ...over });

describe("cleanMessage", () => {
  it("keeps what they wrote, without greeting, sign-off, signature or quoted mail", () => {
    const text = "Hi Alex,\n\nThe pallets left today.\nTracking follows.\n\nBest regards,\nSam Example\nExample Ltd | +44 1234\n\nOn Tue, 3 Nov 2026 at 10:00, Alex <alex@example.test> wrote:\n> Are they on the way?";
    expect(cleanMessage(text)).toBe("The pallets left today.\nTracking follows.");
  });

  it("cuts an Outlook header block and image codes", () => {
    const text = "Paid! Should be with you soon. [cid:abc-123]\n________________________________\nFrom: Alex\nSent: Wednesday\nTo: Sam\nSubject: Invoice";
    expect(cleanMessage(text)).toBe("Paid! Should be with you soon.");
  });

  it("cuts quoted mail that came flattened onto one line", () => {
    expect(cleanMessage("Please see the invoice attached. Thanks, Alex On Wed, 11 Nov 2026 at 09:25, Sam Example wrote: > Hi Alex"))
      .toBe("Please see the invoice attached. Thanks, Alex");
  });
});

describe("promiseIn", () => {
  it("finds the sentence where we promise something", () => {
    expect(promiseIn("Hi Tom,\n\nThanks, great news on the reports. I'll come back to you once I've firmed up an offer.\n\nBest,\nAlex"))
      .toBe("I'll come back to you once I've firmed up an offer.");
    expect(promiseIn("No worries on the reports. We’ll be back in touch as soon as we have a buyer.")).toBe("We’ll be back in touch as soon as we have a buyer.");
  });

  it("finds none in a question, or in an older promise quoted below", () => {
    expect(promiseIn("How many packs do you have, and is there a test report for any of them?")).toBeNull();
    expect(promiseIn("Any news?\n\nOn Mon, 2 Nov 2026 at 10:00, Alex wrote:\n> I'll come back to you next week.")).toBeNull();
  });
});

describe("whoseMove", () => {
  it("is ours when their message is the newest, on any channel", () => {
    const p = whoseMove({ stage: "offered", override: null, now: NOW, messages: [
      msg("a", "outbound", "2026-11-09T08:00:00Z", "How many do you have?"),
      msg("b", "inbound", "2026-11-10T14:00:00Z", "About 20, price to follow", { channel: "whatsapp", subject: null }),
    ] });
    expect(p).toMatchObject({ turn: "us", since: "2026-11-10T14:00:00Z", source: "message", chase: false });
    expect(p.reason).toBe("Their WhatsApp on 10 Nov is the newest message.");
    expect(p.next).toBe("Answer their WhatsApp of 10 Nov.");
  });

  it("is ours when our newest message promised them something", () => {
    const p = whoseMove({ stage: "offered", override: null, now: NOW, messages: [msg("a", "outbound", "2026-10-27T13:00:00Z", "Thanks. I'll come back to you once I've firmed up an offer.")] });
    expect(p).toMatchObject({ turn: "us", source: "promise", days: 16 });
    expect(p.reason).toBe("You wrote on 27 Oct: “I'll come back to you once I've firmed up an offer.”");
  });

  it("is theirs after our message, and due a chase after three working days", () => {
    const fresh = whoseMove({ stage: "offered", override: null, now: NOW, messages: [msg("a", "outbound", "2026-11-11T08:00:00Z", "How many do you have?")] });
    expect(fresh).toMatchObject({ turn: "them", chase: false, next: "Waiting for their reply." });
    const due = whoseMove({ stage: "offered", override: null, now: NOW, messages: [msg("a", "outbound", "2026-11-09T08:00:00Z", "How many do you have?")] });
    expect(due).toMatchObject({ turn: "them", chase: true, next: "Chase: no reply since 9 Nov." });
    expect(due.reason).toBe("You wrote on 9 Nov. No reply in 3 working days.");
  });

  it("does not chase once chasing was switched off, until a newer message", () => {
    const messages = [msg("a", "outbound", "2026-11-09T08:00:00Z", "How many do you have?")];
    expect(whoseMove({ stage: "offered", override: null, now: NOW, messages, chaseOffAt: "2026-11-12T09:00:00Z" }).chase).toBe(false);
    expect(whoseMove({ stage: "offered", override: null, now: NOW, messages, chaseOffAt: "2026-11-01T09:00:00Z" }).chase).toBe(true);
  });

  it("ignores an out-of-office reply", () => {
    const p = whoseMove({ stage: "offered", override: null, now: NOW, messages: [
      msg("a", "outbound", "2026-11-09T08:00:00Z", "How many do you have?"),
      msg("b", "inbound", "2026-11-09T08:01:00Z", "I am out of the office until Monday.", { subject: "Automatic reply: Packs" }),
    ] });
    expect(p.turn).toBe("them");
    expect(isAutoReply({ subject: "Out of office", text: "" })).toBe(true);
  });

  it("follows a move set by hand until a newer message arrives", () => {
    const messages = [msg("a", "inbound", "2026-11-09T08:00:00Z", "Any news?")];
    expect(whoseMove({ stage: "offered", messages, now: NOW, override: { who: "them", at: "2026-11-10T09:00:00Z" } }))
      .toMatchObject({ turn: "them", source: "manual", reason: "Set by hand on 10 Nov." });
    expect(whoseMove({ stage: "offered", messages, now: NOW, override: { who: "them", at: "2026-11-08T09:00:00Z" } }).turn).toBe("us");
  });

  it("goes by the saved status only when no message is linked at all", () => {
    expect(whoseMove({ stage: "offered", messages: [], override: null, now: NOW, saved: { who: "them", since: "2026-11-02T12:00:00Z" } }))
      .toMatchObject({ turn: "them", source: "saved", chase: true, reason: "No email or WhatsApp linked. Going by the saved status. No reply in 8 working days." });
    expect(whoseMove({ stage: "offered", messages: [], override: null, now: NOW }))
      .toMatchObject({ turn: "us", next: "Link their email or WhatsApp, or set whose move.", source: "none" });
    expect(whoseMove({ stage: "offered", messages: [msg("a", "inbound", "2026-11-09T08:00:00Z", "Hi")], override: null, now: NOW, saved: { who: "them", since: null } }).turn).toBe("us");
  });

  it("is closed for a finished deal, and ours with nothing sent", () => {
    expect(whoseMove({ stage: "lost", messages: [], override: null, now: NOW }).turn).toBe("closed");
    expect(whoseMove({ stage: "candidate", messages: [], override: null, now: NOW })).toMatchObject({ turn: "us", next: "Make first contact.", source: "none" });
  });
});

describe("nextStep", () => {
  const ours = whoseMove({ stage: "offered", override: null, now: NOW, messages: [msg("a", "inbound", "2026-10-28T15:00:00Z", "Final price.")] });
  it("shows the stored step while it is newer than the newest message", () => {
    expect(nextStep({ text: "Decide: take it or drop it.", at: "2026-10-28T23:59:59Z" }, ours, "2026-10-28T15:00:00Z")).toBe("Decide: take it or drop it.");
  });
  it("falls back to what the turn says when the stored step is older, or when it is their move", () => {
    expect(nextStep({ text: "Old step.", at: "2026-10-20T10:00:00Z" }, ours, "2026-10-28T15:00:00Z")).toBe("Answer their email of 28 Oct.");
    const theirs = whoseMove({ stage: "offered", override: null, now: NOW, messages: [msg("a", "outbound", "2026-11-09T08:00:00Z", "How many?")] });
    expect(nextStep({ text: "Offer them a price.", at: "2026-11-10T10:00:00Z" }, theirs, "2026-11-09T08:00:00Z")).toBe("Chase: no reply since 9 Nov.");
  });
});

describe("priceLine", () => {
  it("shows what a seller asks against our bid, and the gap", () => {
    const line = priceLine({ amount: 4250, unit: "pack", currency: "EUR", firmness: "final: max discount already in", our_bid: { on: "2026-10-28", amount: 3500, currency: "EUR" } }, "seller");
    expect(line).toEqual({ gap: "€750 apart", parts: [
      { label: "They ask", value: "€4,250 / pack", note: "final", kind: "theirs" },
      { label: "You bid", value: "€3,500 / pack", note: "28 Oct", kind: "ours" },
    ] });
  });

  it("reads a range, another currency, and a list of items", () => {
    expect(priceLine({ amount_low: 55, amount_high: 58, unit: "kWh", currency: "EUR", stated_on: "2026-10-21" }, "seller")?.parts[0])
      .toEqual({ label: "They ask", value: "€55–58 / kWh", note: "21 Oct", kind: "theirs" });
    expect(priceLine({ amount: 700, unit: "kWh", currency: "SEK" }, "seller")?.parts[0].value).toBe("SEK 700 / kWh");
    expect(priceLine({ items: [{ model: "Zoe R90 41 kWh, 2019", amount: 1750, currency: "EUR", unit: "pack" }, { model: "Ioniq 73 kWh", amount: 3000, currency: "EUR", unit: "pack" }] }, "seller")?.parts[0].value)
      .toBe("€1,750 / pack Zoe R90 41 kWh · €3,000 / pack Ioniq 73 kWh");
  });

  it("marks what is missing, and has nothing to say with no price at all", () => {
    expect(priceLine({}, "seller")).toBeNull();
    expect(priceLine({ amount: 10, currency: "EUR", unit: "kWh" }, "seller")?.parts[1]).toEqual({ label: "You bid", value: "not yet", note: null, kind: "none" });
  });

  it("shows a buyer our price and their budget", () => {
    const line = priceLine({ unit: "kWh", currency: "EUR", our_ask: { amount: 30, asked_on: "2026-10-26" }, buyer_budget: { meb82: { low: 20, high: 25 } } }, "buyer");
    expect(line?.parts).toEqual([
      { label: "You asked for", value: "€30 / kWh", note: "26 Oct", kind: "ours" },
      { label: "Their budget", value: "€20–25 / kWh (MEB82)", note: null, kind: "theirs" },
    ]);
    expect(money(1234.5, "GBP", null)).toBe("£1,234.5");
  });

  it("lists the dated moves, oldest first", () => {
    expect(priceMoves({ amount: 4250, unit: "pack", currency: "EUR", stated_on: "2026-10-27", our_bid: { on: "2026-10-28", amount: 3500 } }, "seller")).toEqual([
      { at: "2026-10-27T12:00:00Z", who: "They", text: "priced it at €4,250 / pack." },
      { at: "2026-10-28T12:00:00Z", who: "You", text: "bid €3,500 / pack." },
    ]);
  });
});

describe("ladder", () => {
  const states = (steps: { state: string }[]) => steps.map((s) => s.state).join(" ");
  it("marks every step up to the furthest reached", () => {
    expect(states(ladder({ stage: "offered", terms: { amount: 1, our_bid: { amount: 1 } }, side: "seller", contacted: true }))).toBe("done done done now todo");
    expect(states(ladder({ stage: "offered", terms: {}, side: "seller", contacted: true }))).toBe("done now todo todo todo");
    expect(states(ladder({ stage: "candidate", terms: {}, side: "seller", contacted: false }))).toBe("now todo todo todo todo");
  });
  it("uses the existing stages for a buyer", () => {
    expect(ladder({ stage: "invoiced", terms: {}, side: "buyer", contacted: true }).map((s) => `${s.label}:${s.state}`))
      .toEqual(["Asked:done", "Priced:done", "Agreed:done", "Invoiced:done", "Paid:now", "Complete:todo"]);
  });
});

describe("stageHint", () => {
  it("suggests Paid from their message, furthest first", () => {
    const hint = stageHint({ stage: "contract_out", skipped: null, messages: [
      msg("a", "outbound", "2026-11-11T12:39:00Z", "Hi Sam,\n\nPlease see the deposit invoice attached.\n\nThanks,\nAlex"),
      msg("b", "inbound", "2026-11-11T13:16:00Z", "Hi, Paid! Should be reflected in your account soon. Regards"),
    ] });
    expect(hint).toEqual({ stage: "paid", messageId: "b", at: "2026-11-11T13:16:00Z", channel: "mail", quote: "Paid!" });
  });

  it("suggests Invoice out when we sent the invoice, and nothing once skipped or already there", () => {
    const sent = [msg("a", "outbound", "2026-11-11T12:39:00Z", "Please find the invoice attached.")];
    expect(stageHint({ stage: "signed", skipped: null, messages: sent })?.stage).toBe("invoiced");
    expect(stageHint({ stage: "signed", skipped: "a", messages: sent })).toBeNull();
    expect(stageHint({ stage: "paid", skipped: null, messages: sent })).toBeNull();
  });

  it("does not read a future payment as paid", () => {
    expect(stageHint({ stage: "invoiced", skipped: null, messages: [msg("a", "inbound", "2026-11-11T12:00:00Z", "It will be paid once the reports arrive.")] })).toBeNull();
  });
});
