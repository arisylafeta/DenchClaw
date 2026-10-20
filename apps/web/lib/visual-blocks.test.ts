import { describe, expect, it } from "vitest";
import { buildVisualDoc, splitVisualBlocks } from "./visual-blocks";

describe("splitVisualBlocks", () => {
  it("returns plain text untouched", () => {
    expect(splitVisualBlocks("hello ```js\nx\n```")).toEqual([{ type: "text", text: "hello ```js\nx\n```" }]);
  });
  it("splits text around a closed visual fence", () => {
    expect(splitVisualBlocks("Intro\n```visual\n<svg></svg>\n```\nOutro")).toEqual([
      { type: "text", text: "Intro" }, { type: "visual", code: "<svg></svg>", closed: true }, { type: "text", text: "Outro" },
    ]);
  });
  it("marks a still-streaming fence as unclosed and accepts the visualizer alias", () => {
    expect(splitVisualBlocks("```visualizer\n<div>part")).toEqual([{ type: "visual", code: "<div>part", closed: false }]);
  });
  it("keeps ordinary code fences inside text", () => {
    const out = splitVisualBlocks("```ts\nconst a = 1\n```\n```visual\n<svg/>\n```");
    expect(out[0]).toEqual({ type: "text", text: "```ts\nconst a = 1\n```" });
    expect(out[1]).toMatchObject({ type: "visual", closed: true });
  });
});

describe("buildVisualDoc", () => {
  const doc = buildVisualDoc("<svg></svg>", { "--color-accent": "#687000", "--color-bg": "red;} body{display:none" }, "v1");
  it("locks the frame down with a CSP that blocks network and forms", () => {
    expect(doc).toContain("default-src 'none'");
    expect(doc).toContain("connect-src 'none'");
    expect(doc).toContain("form-action 'none'");
  });
  it("injects host theme variables but strips CSS-breaking characters", () => {
    expect(doc).toContain("--color-accent:#687000");
    expect(doc).not.toContain("} body{display:none");
  });
  it("exposes the sendPrompt bridge and height reporting", () => {
    expect(doc).toContain("window.sendPrompt");
    expect(doc).toContain("visual-height");
  });
});
