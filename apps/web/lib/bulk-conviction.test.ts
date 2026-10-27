import { describe, expect, it } from "vitest";
import { convictionOf, convictionScoreSql } from "./bulk-conviction";

describe("conviction", () => {
  it("defaults to medium", () => {
    expect(convictionOf(undefined)).toBe("medium");
    expect(convictionOf("high")).toBe("high");
    expect(convictionOf("bogus")).toBe("medium");
  });
  it("builds a capped multiplier expression", () => {
    const sql = convictionScoreSql("score_expr", "ctx");
    expect(sql).toContain("least(100");
    expect(sql).toContain("ctx->>'conviction'");
  });
});
