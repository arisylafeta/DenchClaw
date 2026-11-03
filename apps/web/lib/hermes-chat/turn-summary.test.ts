import { describe, expect, it } from "vitest";
import { summarizeTurn } from "./turn-summary";

describe("summarizeTurn", () => {
  it("strips markdown, code blocks and links", () => {
    expect(summarizeTurn("## Done\n\n**Fixed** the [mic](http://x) bug.\n```ts\nconst a=1\n```")).toBe("Done Fixed the mic bug.");
  });
  it("cuts long text at a sentence end, else at a word", () => {
    const s = `${"First sentence here. ".repeat(3)}${"word ".repeat(60)}`;
    expect(summarizeTurn(s, 70)).toMatch(/\.$/);
    expect(summarizeTurn("word ".repeat(60), 40).endsWith("…")).toBe(true);
  });
  it("returns empty for blank text", () => { expect(summarizeTurn(" \n ")).toBe(""); });
});
