import { describe, expect, it } from "vitest";
import { greetingRule, pickExamples, voiceExamplesBlock, voiceGuideBlock } from "./relay-voice";

const ex = (inbound: string, contact_type: string | null, sent_at: string, reply = "Hi Tom,\n\nThanks.\n\nBest,\nAlex") => ({ inbound, reply, contact_type, sent_at });

describe("pickExamples", () => {
  it("prefers the same kind of contact, then shared words, then newest", () => {
    const pool = [
      ex("Can you quote for Leaf modules collected from Leeds?", "supplier", "2026-01-01"),
      ex("What price for Leaf modules?", "buyer", "2025-01-01"),
      ex("Hello there", "buyer", "2026-06-01"),
      ex("Leaf modules price per kWh please", "buyer", "2024-01-01"),
    ];
    const got = pickExamples(pool, "buyer", "Price for your Leaf modules per kWh?", 3);
    // Both buyer emails share three words with theirs, so the newer one leads; the supplier one never beats a buyer one.
    expect(got.map((e) => e.inbound)).toEqual(["What price for Leaf modules?", "Leaf modules price per kWh please", "Hello there"]);
  });
  it("works with no contact type and an empty pool", () => {
    expect(pickExamples([], null, "x")).toEqual([]);
    expect(pickExamples([ex("a", null, "2026-01-01")], null, "")).toHaveLength(1);
  });
});

describe("voice blocks", () => {
  it("says nothing without a voice", () => {
    expect(voiceGuideBlock(null)).toBe("");
    expect(voiceExamplesBlock(null, [])).toBe("");
    expect(greetingRule(false)).toContain('sign off "Best');
  });
  it("marks examples as style only and keeps the card", () => {
    const block = voiceExamplesBlock("**When** a buyer asks price", [ex("Price?", "buyer", "2026-01-01")]);
    expect(block).toContain("**When** a buyer asks price");
    expect(block).toContain("style only");
    expect(block).toContain("Alex replied:\nHi Tom,");
    expect(greetingRule(true)).toContain("How Alex writes");
  });
});
