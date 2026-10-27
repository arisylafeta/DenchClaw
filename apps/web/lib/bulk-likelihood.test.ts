import { describe, expect, it } from "vitest";
import { likelihoodOf, likelihoodScoreSql } from "./bulk-likelihood";

describe("likelihood", () => {
  it("accepts 0-100 numbers only", () => {
    expect(likelihoodOf(40)).toBe(40);
    expect(likelihoodOf(0)).toBe(0);
    expect(likelihoodOf(101)).toBeNull();
    expect(likelihoodOf("40")).toBeNull();
    expect(likelihoodOf(undefined)).toBeNull();
  });
  it("builds a multiplier expression that keeps unset scores", () => {
    const sql = likelihoodScoreSql("score_expr", "ctx");
    expect(sql).toContain("ctx->>'likelihood'");
    expect(sql).toContain(", 1)");
  });
});
