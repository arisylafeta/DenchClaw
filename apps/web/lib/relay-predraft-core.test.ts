import { describe, expect, it } from "vitest";
import { isFresh, parseSuggestion } from "./relay-predraft-core";

const at = "2026-11-01T10:00:00.000Z";
const draft = { body: "Hi Tom,\n\nAny news?\n\nBest,\nAlex", subject: "Re: packs", needs_input: null, todos: [], for_message_id: "m2", voice_version: 1, at };

describe("parseSuggestion", () => {
  it("reads a draft with subject and promise to-dos", () => {
    const got = parseSuggestion(`Here: {"subject": "Re: packs", "body": "Hi Tom,\\n\\nThanks.", "needs_input": null,
      "todos": [{"title": "Send the stock list", "detail": "by Friday", "kind": "promise"}, {"title": ""}]}`);
    expect(got).toEqual({ body: "Hi Tom,\n\nThanks.", subject: "Re: packs", needs_input: null, todos: [{ title: "Send the stock list", detail: "by Friday", kind: "promise" }] });
  });
  it("reads a question for Alex and drops any body that came with it", () => {
    const got = parseSuggestion(JSON.stringify({ body: "We can do £40", needs_input: { question: "What price do you want to offer?", options: ["ask for their price", "offer 38 per kWh", " "] } }));
    expect(got.body).toBe("");
    expect(got.needs_input).toEqual({ question: "What price do you want to offer?", options: ["ask for their price", "offer 38 per kWh"] });
  });
  it("refuses a question with fewer than two options and an empty draft", () => {
    expect(() => parseSuggestion(JSON.stringify({ body: "", needs_input: { question: "Price?", options: ["x"] } }))).toThrow();
    expect(() => parseSuggestion("nothing")).toThrow();
  });
});

describe("isFresh", () => {
  const now = Date.parse(at);
  it("is fresh only for the newest message Relay saw", () => {
    expect(isFresh(draft, "m2", "action", now)).toBe(true);
    expect(isFresh(draft, "m3", "action", now)).toBe(false);
    expect(isFresh({ failed_for: "m2", error: "x", at }, "m2", "action", now)).toBe(false);
    expect(isFresh(null, "m2", "action", now)).toBe(false);
  });
  it("lets a chase go stale after three days", () => {
    expect(isFresh(draft, "m2", "follow", now + 2 * 86_400_000)).toBe(true);
    expect(isFresh(draft, "m2", "follow", now + 4 * 86_400_000)).toBe(false);
    expect(isFresh(draft, "m2", "action", now + 30 * 86_400_000)).toBe(true);
  });
});
