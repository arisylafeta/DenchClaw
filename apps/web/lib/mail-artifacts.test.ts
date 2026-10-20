import { describe, expect, it } from "vitest";
import { mailDraftPath, parseMailDraftPath, splitArtifactBlocks } from "./mail-artifacts";

describe("splitArtifactBlocks", () => {
  it("extracts a mail draft reference between prose", () => {
    const text = 'Draft ready.\n```artifact\n{"kind":"mail_draft","id":"abc123","title":"Ioniq 5 enquiry"}\n```\nNot sent.';
    expect(splitArtifactBlocks(text)).toEqual([
      { type: "text", text: "Draft ready.\n" },
      { type: "artifact", artifact: { kind: "mail_draft", id: "abc123", title: "Ioniq 5 enquiry" } },
      { type: "text", text: "\nNot sent." },
    ]);
  });
  it("keeps invalid, unknown and unsafe blocks as text", () => {
    for (const body of ['{"kind":"other","id":"x"}', "not json", '{"kind":"mail_draft","id":"../etc"}', '{"kind":"mail_draft"}']) {
      const text = "```artifact\n" + body + "\n```";
      expect(splitArtifactBlocks(text)).toEqual([{ type: "text", text }]);
    }
  });
  it("leaves plain text untouched", () => {
    expect(splitArtifactBlocks("hello")).toEqual([{ type: "text", text: "hello" }]);
  });
});

describe("mail draft paths", () => {
  it("round-trips safe ids only", () => {
    expect(parseMailDraftPath(mailDraftPath("abc-1_2"))).toBe("abc-1_2");
    expect(parseMailDraftPath("~mail/draft/../x")).toBeNull();
    expect(parseMailDraftPath("other/abc")).toBeNull();
  });
});
