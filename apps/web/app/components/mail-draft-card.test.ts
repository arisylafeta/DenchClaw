import { describe, expect, it } from "vitest";
import { excerpt } from "./mail-draft-card";

describe("excerpt", () => {
  it("skips the greeting and drops the signature paragraphs", () => {
    const text = "Hi team,\n\nFirst point.\n\nSecond point.\n\nBest,\nAri\n\nReBattery https://rebattery.io";
    expect(excerpt(text)).toBe("First point. Second point.");
  });
  it("handles empty and null bodies", () => {
    expect(excerpt(null)).toBe("");
    expect(excerpt("  ")).toBe("");
  });
});
