import { describe, expect, it } from "vitest";
import type { Segment } from "@/lib/hermes-chat/reducer";
import { splitTurn } from "./work-block";

const seg = (type: "text" | "reasoning" | "interim", text: string, id = `${type}-${text}`): Segment => ({ type, id, text, startedAt: 1 });
const tool: Segment = { type: "tool", id: "t", toolId: "t", name: "x", startedAt: 1 } as Segment;

describe("splitTurn", () => {
  it("keeps the answer visible when reasoning arrives after it", () => {
    const { work, answer } = splitTurn([seg("reasoning", "plan"), seg("text", "Final answer"), seg("reasoning", "late summary")]);
    expect(answer.map(a => a.text)).toEqual(["Final answer"]);
    expect(work.map(w => w.type)).toEqual(["reasoning", "reasoning"]);
  });
  it("still treats text before a later tool as narration, not the answer", () => {
    const { work, answer } = splitTurn([seg("text", "Checking"), tool, seg("text", "Done")]);
    expect(answer.map(a => a.text)).toEqual(["Done"]);
    expect(work).toHaveLength(2);
  });
  it("has no answer when the turn ends on a tool", () => {
    expect(splitTurn([seg("text", "Checking"), tool]).answer).toEqual([]);
  });
});
