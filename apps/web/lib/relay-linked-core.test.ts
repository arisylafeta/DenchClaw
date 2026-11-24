import { describe, expect, it } from "vitest";
import { costClashes, listingSlugs, mailbox, newestSlugs, sameMailbox, secretCosts, stockTags, threadScore, type KnownCost } from "./relay-linked-core";

const ID3: KnownCost = { label: "VW ID.3 55 kWh, 2025", supplier: "LKQ Synetiq", amount: 1674, currency: "GBP", source: "Ricki Mayhew (Synetiq) price sheet 19 Oct 2026", listed: 1880 };

describe("the same person", () => {
  it("reads an address with or without its dots as one", () => {
    expect(mailbox("Ricki.Mayhew@LKQsynetiq.co.uk")).toBe("rickimayhew@lkqsynetiq.co.uk");
    expect(sameMailbox("rickimayhew@lkqsynetiq.co.uk", "ricki.mayhew@lkqsynetiq.co.uk")).toBe(true);
    expect(sameMailbox("ricki@lkqsynetiq.co.uk", "ricki.mayhew@lkqsynetiq.co.uk")).toBe(false);
    expect(sameMailbox("a@b.co.uk", "a@bco.uk")).toBe(false);
    expect(sameMailbox(null, null)).toBe(false);
  });
});

describe("what an email is about", () => {
  it("finds listing links, in any language", () => {
    expect(listingSlugs("https://www.rebattery.io/marketplace/volkswagen-id3-pure-match-55kwh-2aa3 and rebattery.io/de/marketplace/skoda-enyaq-8bea, https://www.rebattery.io/marketplace/auctions/x-lot"))
      .toEqual(["volkswagen-id3-pure-match-55kwh-2aa3", "skoda-enyaq-8bea"]);
  });
  it("takes the newest email that links any", () => {
    expect(newestSlugs(["Yes happy to take that gamble", "https://www.rebattery.io/marketplace/id3-2aa3", "https://www.rebattery.io/marketplace/enyaq-8bea https://www.rebattery.io/marketplace/id3-2aa3"])).toEqual(["id3-2aa3"]);
    expect(newestSlugs(["nothing"])).toEqual([]);
  });
  it("finds stock tags, not other numbers", () => {
    expect(stockTags("2025 VW ID.3 (tag 13319144), call 01452 833333")).toEqual(["13319144"]);
    expect(stockTags("a price tag of 1,570")).toEqual([]);
  });
  it("picks the thread about the same pack", () => {
    const about = "VW ID.3 Pure Match 55kWh (2025) - tag 13319144 - mileage and SOH";
    expect(threadScore(about, "Re: VW ID.3 Pure Match 55kWh (2025) - tag 13319144 - mileage and SOH")).toBeGreaterThan(threadScore(about, "ReBattery EV Pack Demand List - Full 13262842"));
  });
});

describe("a price under the recorded cost", () => {
  it("says by how much, and where the cost came from", () => {
    expect(costClashes("I'll make the invoice out to Somerset EV Ltd at £1,570 plus delivery", [ID3]))
      .toEqual(["£1,570 is £104 under the cost on record for VW ID.3 55 kWh, 2025: £1,674 (Ricki Mayhew (Synetiq) price sheet 19 Oct 2026)."]);
  });
  it("says nothing at or over the cost, for small sums, other currencies or no cost", () => {
    expect(costClashes("£1,674 plus £150 delivery, or £1,880", [ID3])).toEqual([]);
    expect(costClashes("€1,570", [ID3])).toEqual([]);
    expect(costClashes("£1,570", [])).toEqual([]);
    expect(costClashes("1,570 cells, 4,500 miles", [ID3])).toEqual([]);
  });
  it("with several packs in play, only a figure under the cheapest is certain", () => {
    expect(costClashes("£1,570", [ID3, { ...ID3, label: "Enyaq", amount: 1400 }])).toEqual([]);
    expect(costClashes("£1,300", [ID3, { ...ID3, label: "Enyaq", amount: 1400 }])[0]).toContain("Enyaq");
  });
  it("keeps a cost out of the buyer's email unless it is the public price", () => {
    expect(secretCosts([ID3, { ...ID3, amount: 1880 }])).toEqual([ID3]);
  });
});
