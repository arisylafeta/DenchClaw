import { describe, expect, it } from "vitest";
import { fillGaps, gapCount, hasGap, preview, segments, verifyWays } from "./relay-ways-core";

const DRAFT = "Hi Sam,\n\nWe can source [BLANK: how many packs] as one lot, at [BLANK: your price per kWh].\n\nBest,\nAlex";

describe("gaps", () => {
  it("finds labelled gaps in order", () => {
    expect(gapCount(DRAFT)).toBe(2);
    expect(segments(DRAFT)).toEqual([
      { text: "Hi Sam,\n\nWe can source " },
      { gap: "how many packs", index: 0 },
      { text: " as one lot, at " },
      { gap: "your price per kWh", index: 1 },
      { text: ".\n\nBest,\nAlex" },
    ]);
  });

  it("reads a bare marker and the old all-capitals kind", () => {
    expect(segments("Price: [BLANK]. Date: [DELIVERY DATE].")).toEqual([
      { text: "Price: " }, { gap: "", index: 0 }, { text: ". Date: " }, { gap: "delivery date", index: 1 }, { text: "." },
    ]);
  });

  it("reads a marker the writer did not put quite right", () => {
    const loose: [string, string][] = [
      ["[BLANK - price]", "price"], ["[BLANK price]", "price"], ["[BLANK:]", ""], ["[ BLANK ]", ""], ["[ PRICE ]", "price"],
      ["[blank: which day]", "which day"], ["[BLANK: the price\nper kWh]", "the price per kWh"], [`[BLANK: ${"long ".repeat(30)}]`, "long ".repeat(30).trim()],
    ];
    for (const [marker, label] of loose) expect(segments(`At ${marker} now.`)).toEqual([{ text: "At " }, { gap: label, index: 0 }, { text: " now." }]);
  });

  it("takes a label with brackets of its own whole", () => {
    const text = "At [BLANK: price [GBP]] each.";
    expect(segments(text)).toEqual([{ text: "At " }, { gap: "price [GBP]", index: 0 }, { text: " each." }]);
    expect(fillGaps(text, ["£30"])).toBe("At £30 each.");
  });

  it("leaves ordinary brackets alone", () => {
    for (const text of ["See the list [1] below.", "The lot [ref a3f9] is ready.", "Thanks (and [sic] noted).", "Sent from the UK [GB]."]) {
      expect(hasGap(text)).toBe(false);
    }
  });

  it("fills only the gaps that have a value", () => {
    expect(fillGaps(DRAFT, ["about 100 packs", "  "])).toBe("Hi Sam,\n\nWe can source about 100 packs as one lot, at [BLANK: your price per kWh].\n\nBest,\nAlex");
    expect(hasGap(fillGaps(DRAFT, ["about 100 packs", "£28 per kWh"]))).toBe(false);
    expect(fillGaps(DRAFT, [])).toBe(DRAFT);
  });

  it("shows a gap as an ellipsis in a tab", () => {
    expect(preview("Hi Sam,\n\nWe can do [BLANK: how many packs] now.")).toBe("Hi Sam, We can do … now.");
    expect(preview("word ".repeat(40), 30).length).toBeLessThanOrEqual(31);
  });
});

describe("verifyWays", () => {
  const known = "Sam asked for 100 to 200 packs and a target of 20 Eur/kWh. The matrix lists 92 packs.";
  const current = "Hi Sam,\n\nThanks for this. We can line up 92 packs.\n\nBest,\nAlex";
  const hold = { title: "Hold", body: "Hi Sam,\n\nThanks, a separate thread makes sense. I will come back with numbers by [BLANK: which day].\n\nBest,\nAlex" };
  const ask = { title: "Ask first", body: "Hi Sam,\n\nBefore I quote: which pack types matter most to you, and is the 200 a firm number?\n\nBest,\nAlex" };

  it("keeps two other ways and the name of the current draft", () => {
    expect(verifyWays({ current: "Quote now.", ways: [ask, hold] }, current, known)).toEqual({ current: "Quote now", others: [ask, hold] });
  });

  it("drops a way with a number the emails do not have", () => {
    const invented = { title: "Counter", body: "Hi Sam,\n\nWe could do 150 packs at 27 Eur/kWh if you take them all.\n\nBest,\nAlex" };
    expect(verifyWays({ current: "Quote now", ways: [invented, hold] }, current, known).others).toEqual([hold]);
  });

  it("drops a copy of the current draft, a repeat, and a bad title", () => {
    const out = verifyWays({ current: "Quote now", ways: [
      { title: "Same", body: current.replace(/\n\n/g, "\n \n") },
      hold,
      { title: "Hold", body: `${hold.body} Thanks again.` },
      { title: "Offer £20", body: ask.body },
      { title: "", body: ask.body },
      ask,
    ] }, current, known);
    expect(out.others).toEqual([hold, ask]);
  });

  it("keeps at most two, and survives junk", () => {
    const third = { title: "Decline", body: "Hi Sam,\n\nThanks, but this one is not for us right now.\n\nBest,\nAlex" };
    expect(verifyWays({ current: "Quote now", ways: [ask, hold, third] }, current, known).others).toHaveLength(2);
    expect(verifyWays(null, current, known)).toEqual({ current: "First draft", others: [] });
    expect(verifyWays({ current: 7, ways: "no" }, current, known)).toEqual({ current: "First draft", others: [] });
    expect(verifyWays({ current: "Hold", ways: [hold] }, current, known).current).toBe("First draft");
  });
});
