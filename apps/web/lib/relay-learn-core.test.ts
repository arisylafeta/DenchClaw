import { describe, expect, it } from "vitest";
import { learnPrompt, MAX_LEARNED, parseProposals, sameRule, similarity, unchanged } from "./relay-learn-core";

const pairs = [
  { id: "d1", situation: "chase", before: "Hi Tom,\n\nJust checking in on the packs. Any update?", after: "Hi Tom,\n\nAny news on the packs?" },
  { id: "d2", situation: "chase", before: "Hi Ann,\n\nJust checking in on the modules.", after: "Hi Ann,\n\nAny news on the modules?" },
];
const ctx = { pairs, requests: [{ draft_id: "d3", text: "shorter" }, { draft_id: "d3", text: "warmer" }], learned: [{ id: "r1", text: "Keep acknowledgements brief." }], known: ["Two to four short lines. Warm and direct.", "Keep acknowledgements brief.", "Never say just checking in."] };

describe("similarity", () => {
  it("is 1 for the same words and lower as edits grow", () => {
    expect(similarity("Hi Tom, thanks!", "hi tom thanks")).toBe(1);
    expect(similarity(pairs[0].before, pairs[0].after)).toBeLessThan(0.8);
    expect(similarity("", "")).toBe(1);
    expect(similarity("a", "")).toBe(0);
  });
  it("calls a send with a word changed unchanged, a rewrite not", () => {
    const long = "Hi Tom, thanks for sending the photos over. The packs look in good shape and we have a buyer lined up for all twenty of them next week.";
    expect(unchanged(long, long.replace("good", "great"))).toBe(true);
    expect(unchanged(pairs[0].before, pairs[0].after)).toBe(false);
  });
});

describe("sameRule", () => {
  it("matches rewordings with curly quotes and case, not different rules", () => {
    expect(sameRule("Cut detailed recaps of the recipient’s message.", "cut detailed recaps of the recipient's message")).toBe(true);
    expect(sameRule("Keep acknowledgements brief.", "End proposals with a direct question.")).toBe(false);
  });
  it("lets a short rule not block a longer one that merely shares a word", () => {
    expect(sameRule("Be warm.", "Keep a warm tone but cut the opening pleasantries.")).toBe(false);
  });
});

describe("parseProposals", () => {
  it("keeps supported additions and valid removals, with their evidence", () => {
    const got = parseProposals(`Sure: {"add": [{"rule": "Chase with a short question — never 'just checking in'.", "why": "cut it twice", "evidence": ["d1", "d2"]},
      {"rule": "Use fewer words when asked.", "why": "asked twice", "evidence": ["d3"]}],
      "remove": [{"rule_id": "r1", "why": "he adds long thanks", "evidence": ["d2"]}]}`, ctx);
    expect(got.map((p) => [p.action, p.text])).toEqual([
      ["add", "Chase with a short question , never 'just checking in'."],
      ["add", "Use fewer words when asked."],
      ["remove", "Keep acknowledgements brief."],
    ]);
    expect(got[0].evidence[0]).toEqual({ draft_id: "d1", before: pairs[0].before, after: pairs[0].after });
    expect(got[1].evidence).toEqual([{ draft_id: "d3", request: "shorter" }, { draft_id: "d3", request: "warmer" }]);
    expect(got[2].target_id).toBe("r1");
  });
  it("never proposes a removal that is already waiting or was turned down", () => {
    const got = parseProposals(JSON.stringify({ remove: [{ rule_id: "r1", why: "x", evidence: ["d1"] }] }), { ...ctx, blockedTargets: ["r1"] });
    expect(got).toEqual([]);
  });
  it("drops rules without evidence, repeats of known or rejected rules, and unknown removals", () => {
    const got = parseProposals(JSON.stringify({
      add: [{ rule: "No evidence here.", evidence: [] }, { rule: "Never say just checking in", evidence: ["d1"] }, { rule: "Made up", evidence: ["zz"] }],
      remove: [{ rule_id: "nope" }],
    }), ctx);
    expect(got).toEqual([]);
    expect(parseProposals("no json", ctx)).toEqual([]);
  });
});

describe("learnPrompt", () => {
  it("lists every input and asks for a removal when the learned set is full", () => {
    const prompt = learnPrompt({ own: ["Be warm."], learned: Array.from({ length: MAX_LEARNED }, (_, i) => ({ id: `r${i}`, text: `rule ${i}` })), rejected: ["Use bullets."], pairs, requests: ctx.requests, unchanged: 4 });
    expect(prompt).toContain("- Be warm.");
    expect(prompt).toContain("- [r0] rule 0");
    expect(prompt).toContain("- Use bullets.");
    expect(prompt).toContain("every addition needs a removal");
    expect(prompt).toContain("4 other\ndrafts went out unchanged");
  });
});
