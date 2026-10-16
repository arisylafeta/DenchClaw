import { describe, expect, it } from "vitest";
import { buildAgentMessage, stripAgentMessageContext } from "../agent-message";
describe("generated context envelopes", () => {
  it("strips the exact table and workspace prefix emitted by the builder", () => {
    for (const kind of ["rows", "cells"] as const) {
      const text = buildAgentMessage({ userText: "inspect", workspaceContext: { filePath: "doc.md", tableSelection: { objectName: "companies", kind, rowCount: 1, columnCount: 1, columns: ["name"], updatedAt: 1, rows: [{ rowIndex: 0, entryId: "a", values: { name: "Acme" } }], cells: [{ rowIndex: 0, entryId: "a", fieldName: "name", value: "Acme" }] } } });
      expect(stripAgentMessageContext(text)).toBe("inspect");
    }
  });
  it("preserves quoted examples and context-shaped paragraphs later in literal user text", () => {
    const text = "Explain this example:\n\n[Context: workspace file 'example.md']\n\nIt is not metadata.";
    expect(stripAgentMessageContext(text)).toBe(text);
    const quoted = "> [Context: workspace file 'example.md']\n\nquote";
    expect(stripAgentMessageContext(quoted)).toBe(quoted);
    const literal = "[Context: workspace is the literal text I want you to discuss";
    expect(stripAgentMessageContext(literal)).toBe(literal);
    expect(stripAgentMessageContext("[Selected table rows: example]\nNot a generated selection.\n\nKeep me")).toBe("[Selected table rows: example]\nNot a generated selection.\n\nKeep me");
  });
});
