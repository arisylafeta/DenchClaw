import { describe, expect, it } from "vitest";
import { hasPriceMarker, marks, parseTalk, priceMarker, pushHistory, readHistory, readSummary, stockBlock, talkPrompt, toKindOf, type TalkDraftIn } from "./relay-talk-core";
import type { StockFit } from "./relay-price-types";

const NOW = new Date("2026-11-20T10:00:00Z");

const REPLY: TalkDraftIn = {
  id: "d-reply", role: "primary", title: "Reply to Ben Bament", to: ["ben@silentclassics.co.uk"], toKind: "buyer",
  body: "Hi Ben,\n\nThanks for getting in touch. We've got a 2020 VW ID.3 62 kWh at [BLANK: price for VW ID.3 62 kWh, 2020 (ref bulk:41)] collected.\n\nBest,\nAlex",
  sendMode: "with_reply", sendAt: null, included: true, sent: false,
};
const ROBERTO: TalkDraftIn = {
  id: "d-rob", role: "follow", title: "Ask Parts Roberto for the VIN", to: ["vendite@partsroberto.it"], toKind: "supplier",
  body: "Hi Roberto,\n\nIs the ID.3 62 kWh still available?\n\nThanks,\nAlex", sendMode: "with_reply", sendAt: null, included: true, sent: false,
};
const SENT: TalkDraftIn = { ...ROBERTO, id: "d-sent", title: "Old note", sent: true };
const DRAFTS = [REPLY, ROBERTO, SENT];

const FIT: StockFit = {
  key: "bulk:41", label: "VW ID.3 62 kWh, 2020", kind: "supplier", supplier: { name: "Parts Roberto", country: "IT", email: "vendite@partsroberto.it" },
  kwh: 62, year: 2020, soh: null, cost: { amount: 4500, currency: "GBP" }, listed: null, href: null,
};

const KNOWN = "Ben asked for a 55 or 62 kWh MEB pack delivered to BA2 0BS. Parts Roberto wants £4,500.";
const parse = (answer: unknown, drafts = DRAFTS) => parseTalk(typeof answer === "string" ? answer : JSON.stringify(answer), drafts, { known: KNOWN, now: NOW });

describe("the prompt", () => {
  const prompt = talkPrompt({
    context: "Writing to: ben@silentclassics.co.uk", rules: ["Two to four short lines."], guide: null, drafts: DRAFTS,
    turns: [{ role: "alex", text: "friendlier", target: "d-reply" }, { role: "trace", text: "Checked 6 emails", target: "d-reply" }, { role: "relay", text: "Done: a warmer opening.", target: "d-reply" }],
    target: "d-rob", stock: [FIT], text: "also ask for photos", earlierAsks: ["friendlier", "warmer please"], now: NOW,
  });

  it("states what Relay may and must never do", () => {
    expect(prompt.system).toContain("You never send anything");
    expect(prompt.system).toContain("[BLANK: price for <label> (ref <key>)]");
    expect(prompt.system).toContain("never carries a supplier's name");
    expect(prompt.system).toContain("never carries the buyer's name");
    expect(prompt.system).toContain("Offer to save a writing rule");
    expect(prompt.system).toContain("Ask for research");
    expect(prompt.system).toContain("- Two to four short lines.");
  });

  it("gives the drafts, the target, the stock, the chat and Alex's words", () => {
    expect(prompt.user).toContain("=== draft d-reply · the reply · to ben@silentclassics.co.uk (the buyer) · goes with the reply");
    expect(prompt.user).toContain("=== draft d-sent · linked email: Old note · to vendite@partsroberto.it (a supplier) · already sent, can't change");
    expect(prompt.user).toContain("Alex is talking about draft d-rob (Ask Parts Roberto for the VIN). He says:\nalso ask for photos");
    expect(prompt.user).toContain("- ref bulk:41: VW ID.3 62 kWh, 2020; 62 kWh, 2020. Supplier stock from Parts Roberto (IT) <vendite@partsroberto.it>; cost £4,500.");
    expect(prompt.user).toContain("Alex: friendlier\nRelay: Done: a warmer opening.");
    expect(prompt.user).not.toContain("Checked 6 emails");
    expect(prompt.user).toContain("- warmer please");
  });

  it("says when nothing fits", () => {
    expect(stockBlock([])).toBe("Stock that fits: none found.");
  });
});

describe("reading the answer", () => {
  it("keeps a valid edit, add, to-do, rule offer and research ask", () => {
    const { answer, notes } = parse({
      say: "Warmer now, and I've added a chase.",
      edits: [{ draftId: "d-reply", body: REPLY.body.replace("Thanks for getting in touch.", "Great to hear from you."), reason: "warmer opening" }],
      add: [{ to: "Ben@SilentClassics.co.uk", toName: "Ben", kind: "buyer", title: "Chase Ben", subject: "Re: ID.3", body: "Hi Ben,\n\nJust checking the prices reached you.\n\nBest,\nAlex", sendMode: "unless_reply", sendAt: "2026-11-25T09:00:00Z", why: "in case he goes quiet" }],
      todo: { title: "Send Ben the age and mileage from the VIN", detail: "Promised in the reply" },
      ruleOffer: { text: "Warm and friendly with returning buyers", why: "You asked for friendlier 9 times" },
      research: { ask: "Which ID.3 packs have a health report?" },
    });
    expect(notes).toEqual([]);
    expect(answer.edits).toEqual([{ draftId: "d-reply", body: expect.stringContaining("Great to hear from you."), reason: "warmer opening" }]);
    expect(answer.add).toEqual([expect.objectContaining({ to: "ben@silentclassics.co.uk", kind: "buyer", sendMode: "unless_reply", sendAt: "2026-11-25T09:00:00.000Z", included: true })]);
    expect(answer.todo?.title).toBe("Send Ben the age and mileage from the VIN");
    expect(answer.ruleOffer?.text).toBe("Warm and friendly with returning buyers");
    expect(answer.research?.ask).toContain("health report");
  });

  it("drops edits to unknown or sent drafts, empty bodies and no-op edits", () => {
    const { answer, notes } = parse({
      edits: [
        { draftId: "nope", body: "x" }, { draftId: "d-sent", body: "New text" }, { draftId: "d-rob", body: "" }, { draftId: "d-rob", body: ROBERTO.body },
      ],
    });
    expect(answer.edits).toEqual([]);
    expect(notes).toEqual([
      "Skipped an edit to a draft that isn't here (nope).",
      'Left "Old note" alone: it has already gone.',
      'Skipped an edit to "Ask Parts Roberto for the VIN": the new text was empty.',
    ]);
    expect(answer.say).toBe("Nothing to change there.");
  });

  it("refuses a price the model made up, but keeps one it was given", () => {
    const made = parse({ edits: [{ draftId: "d-reply", body: REPLY.body.replace(/\[BLANK[^\]]*\]/, "£5,200") }] });
    expect(made.answer.edits).toEqual([]);
    expect(made.notes[0]).toContain("£5,200, which nothing here backs up");
    const known = parse({ edits: [{ draftId: "d-rob", body: `${ROBERTO.body}\nIs £4,500 still right?` }] });
    expect(known.answer.edits).toHaveLength(1);
  });

  it("drops adds with a bad address or no kind, and caps them at three", () => {
    const add = (to: string, kind: string = "supplier") => ({ to, kind, title: "Ask", body: "Hi,\n\nStill available?\n\nAlex", sendMode: "with_reply" });
    const { answer, notes } = parse({ add: [add("not an email"), add("a@b.com", "cousin"), add("x@y.com"), add("x2@y.com"), add("x3@y.com"), add("x4@y.com")] });
    expect(answer.add.map((a) => a.to)).toEqual(["x@y.com", "x2@y.com", "x3@y.com"]);
    expect(notes).toEqual([
      "Didn't add \"Ask\": not an email isn't an email address.",
      "Didn't add the email to a@b.com: it didn't say who they are.",
      "Added at most 3 emails in one go.",
    ]);
  });

  it("adds a timed email without a usable time unticked", () => {
    const { answer, notes } = parse({ add: [{ to: "ben@silentclassics.co.uk", kind: "buyer", title: "Chase", body: "Hi Ben", sendMode: "at", sendAt: "yesterday" }] });
    expect(answer.add[0]).toMatchObject({ sendMode: "at", sendAt: null, included: false });
    expect(notes[0]).toContain("needs a send time");
  });

  it("never throws on odd output", () => {
    expect(parse("Sure! I made it warmer.").answer.say).toBe("Sure! I made it warmer.");
    expect(parse("Sure! I made it warmer.").notes).toEqual(["Relay's answer had no changes in it, so nothing was changed."]);
    expect(parse("```json\n{\"say\": \"ok\", \"edits\": \"lots\"}\n```").answer).toMatchObject({ say: "ok", edits: [] });
    expect(parse("{ broken").answer.edits).toEqual([]);
    expect(parse("").answer.say).toContain("couldn't work out");
    expect(parse({ say: 4, edits: [null, 7, "x"], add: {}, todo: "do it", ruleOffer: [], research: { ask: 3 } }).answer).toEqual({ say: "Nothing to change there.", edits: [], add: [], todo: null, ruleOffer: null, research: null });
  });
});

describe("marks", () => {
  const show = (before: string, after: string) => marks(before, after).map((m) => [after.slice(m.start, m.end), m.removed]);

  it("marks a changed phrase with what it replaced", () => {
    expect(show("Hi Ben,\n\nThanks for getting in touch.\n\nBest,\nAlex", "Hi Ben,\n\nGreat to hear from you.\n\nBest,\nAlex"))
      .toEqual([["Great to hear from you", "Thanks for getting in touch"]]);
  });

  it("marks an added sentence and a removed word", () => {
    expect(show("We have two packs.", "We have two packs. Happy to hold one.")).toEqual([["Happy to hold one.", ""]]);
    expect(show("We have two good packs.", "We have two packs.")).toEqual([["", "good"]]);
  });

  it("marks nothing when nothing changed", () => {
    expect(marks("Same text.", "Same text.")).toEqual([]);
  });

  it("marks separate changes separately", () => {
    expect(show("Hi Ben, the 62 kWh pack is ready on Monday.", "Hi Ben, the 58 kWh pack is ready on Friday.")).toEqual([["58", "62"], ["Friday", "Monday"]]);
  });
});

describe("history", () => {
  it("keeps the newest twenty, newest last", () => {
    let history: unknown = null;
    for (let n = 0; n < 25; n++) history = pushHistory(history, { body: `v${n}`, at: `2026-11-20T10:${String(n).padStart(2, "0")}:00Z`, reason: "edit", by: "relay" });
    const read = readHistory(history);
    expect(read).toHaveLength(20);
    expect(read[0].body).toBe("v5");
    expect(read[19].body).toBe("v24");
  });

  it("drops entries that aren't copies", () => {
    expect(readHistory([{ body: "a", at: "x", reason: 3, by: "who" }, { at: "x" }, "junk"])).toEqual([{ body: "a", at: "x", reason: "", by: "relay" }]);
  });
});

describe("price markers and kinds", () => {
  it("writes and finds the marker relay-price fills", () => {
    expect(priceMarker(FIT)).toBe("[BLANK: price for VW ID.3 62 kWh, 2020 (ref bulk:41)]");
    expect(hasPriceMarker(REPLY.body)).toBe(true);
    expect(hasPriceMarker("[BLANK: your price per kWh]")).toBe(false);
  });

  it("sends a transport quote and an intro to neither side", () => {
    expect([toKindOf("supplier"), toKindOf("buyer"), toKindOf("transport"), toKindOf("intro")]).toEqual(["supplier", "buyer", "other", "other"]);
  });
});

describe("what Relay read", () => {
  it("counts emails, calls, chats, deals, stock and rules from the pack", () => {
    const summary = readSummary({
      thread: 2,
      sources: [
        { label: "Earlier emails", text: "--- 13 Nov · From ben@x · Price\nhello\n\n--- 14 Nov · From ReBattery · Re: Price\nhi" },
        { label: "Company emails", text: "--- 1 Oct · From sam@x · Hi\nyo" },
        { label: "Calls", text: "--- 2 Nov · Intro · with ben@x\n| notes\n\nEarlier calls, notes not shown: 1 Oct (call); 3 Sep (Intro)" },
        { label: "WhatsApp", text: "13 Nov · Them: hi\n13 Nov · ReBattery: hello" },
        { label: "Their other deals", text: "- They want to buy (open): 82 kWh MEB pack" },
      ],
      deal: null, stock: [FIT, { ...FIT, key: "bulk:42" }, { ...FIT, key: "market:9", supplier: { name: "Silverlake", country: "UK", email: null } }], rules: 6, voice: true,
    });
    expect(summary.items.map((i) => [i.key, i.count])).toEqual([["emails", 5], ["calls", 3], ["whatsapp", 2], ["deals", 1], ["stock", 3], ["rules", 6]]);
    expect(summary.items.find((i) => i.key === "stock")?.text).toBe("3 lines fit: Parts Roberto (2), Silverlake");
    expect(summary.line).toBe("Read before you opened it: 5 emails, 3 calls, 2 WhatsApp messages, their deals, stock, your rules and style");
  });

  it("says so when there was nothing to read", () => {
    const summary = readSummary({ thread: 0, sources: [], deal: null, stock: [], rules: 0, voice: false });
    expect(summary.line).toBe("Nothing read yet");
    expect(summary.items.find((i) => i.key === "calls")?.text).toBe("No calls with them");
  });
});
