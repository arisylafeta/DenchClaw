import { describe, expect, it } from "vitest";
import { apiPayload, declineBody, groupFacts, linkBlock, LISTING_LINK_MARKER, placeLink, readGroups, SELL_PAGE } from "./relay-listings-core";

const packs = {
  label: "Samsung 35E e-bike packs", format: "Pack", description: "E-bike packs of 30 Samsung INR18650-35E cells, in their original casing. Voltage checked, not capacity tested.",
  manufacturer: "Samsung SDI", model: "INR18650-35E", chemistry: "NMC", numCells: "30", originalApplication: "E-mobility",
  location: { country: "United States", countryCode: "us", region: "Florida" },
};

describe("readGroups", () => {
  it("reads a group from what the seller stated", () => {
    const [g] = readGroups([packs]);
    expect(g.location.countryCode).toBe("US");
    expect(g.format).toBe("Pack");
    expect(g.quantity).toBeUndefined();
  });

  it("refuses a condition grade or SoH, which are the seller's to choose", () => {
    expect(() => readGroups([{ ...packs, condition: "great" }])).toThrow(/Group 1: Leave condition and SoH out/);
    expect(() => readGroups([{ ...packs, soh: 90 }])).toThrow(/Leave condition and SoH out/);
  });

  it("refuses what the API would refuse, naming the group", () => {
    expect(() => readGroups([])).toThrow(/at least one group/);
    expect(() => readGroups([packs, { ...packs, format: "Box" }])).toThrow(/Group 2: format must be one of Pack, Module, Cell/);
    expect(() => readGroups([{ ...packs, buyItNowPrice: 100 }])).toThrow(/A price needs its currency/);
    expect(() => readGroups([{ ...packs, location: { country: "USA", countryCode: "USA" } }])).toThrow(/two letters/);
    expect(() => readGroups([{ ...packs, quantity: -3 }])).toThrow(/quantity must be a positive number/);
  });
});

describe("apiPayload", () => {
  it("is always a draft for sale, with the location and the currency of the country, and no empty fields", () => {
    const p = apiPayload(readGroups([packs])[0], "relay-abc-1");
    expect(p).toEqual({
      status: "draft", channelMode: "sale", reference: "relay-abc-1", format: "Pack", description: packs.description,
      manufacturer: "Samsung SDI", model: "INR18650-35E", chemistry: "NMC", numCells: "30", originalApplication: "E-mobility", currency: "USD",
      address: { address: "Florida, United States", country: "United States", countryCode: "US", region: "Florida" },
    });
    expect(p).not.toHaveProperty("condition");
    expect(p).not.toHaveProperty("publish");
  });
});

describe("groupFacts", () => {
  it("says the price is theirs to add when they gave none", () => {
    expect(groupFacts(readGroups([packs])[0])).toEqual(["Samsung SDI INR18650-35E", "pack, 30 cells", "NMC", "Florida, United States", "Price: theirs to add"]);
  });
});

describe("the link in the reply", () => {
  const reply = `Hi there,\n\nI've set up two draft listings from what you sent:\n${LISTING_LINK_MARKER}\n\nBest,\nAlex`;

  it("puts one link where the marker is", () => {
    expect(placeLink(reply, "https://www.rebattery.io/join/abc")).toBe("Hi there,\n\nI've set up two draft listings from what you sent:\nhttps://www.rebattery.io/join/abc\n\nBest,\nAlex");
  });

  it("names each group's link, the first setting up the account", () => {
    expect(linkBlock([{ label: "35E packs", url: "https://www.rebattery.io/join/abc" }, { label: "50E packs", url: "https://www.rebattery.io/supplier/listings/new?invitation=1" }]))
      .toBe("35E packs: https://www.rebattery.io/join/abc\n50E packs: https://www.rebattery.io/supplier/listings/new?invitation=1 (once you've set your password)");
  });

  it("starts several links on their own line when the marker ends a sentence", () => {
    const inline = `I've set up two draft listings from what you sent: ${LISTING_LINK_MARKER}\n\nBest,\nAlex`;
    expect(placeLink(inline, "A: https://x\nB: https://y")).toBe("I've set up two draft listings from what you sent:\nA: https://x\nB: https://y\n\nBest,\nAlex");
    expect(placeLink(inline, "https://x")).toBe("I've set up two draft listings from what you sent: https://x\n\nBest,\nAlex");
  });

  it("goes before the sign-off when the marker was taken out", () => {
    expect(placeLink("Hi there,\n\nHere you go.\n\nBest,\nAlex", "LINK")).toBe("Hi there,\n\nHere you go.\n\nLINK\n\nBest,\nAlex");
    expect(placeLink("Hi there,\n\nHere you go.", "LINK")).toBe("Hi there,\n\nHere you go.\n\nLINK");
  });

  it("puts the sell page in when Alex says not now", () => {
    expect(declineBody(reply)).toContain(SELL_PAGE);
    expect(declineBody(reply)).not.toContain(LISTING_LINK_MARKER);
  });
});
