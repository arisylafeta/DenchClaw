import { describe, expect, it } from "vitest";
import { mailDraftPath, mailMessagePath, parseMailDraftPath, parseMailMessagePath, splitArtifactBlocks } from "./mail-artifacts";

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

describe("mail message artifacts", () => {
  it("extracts a mail message reference", () => {
    const text = '```artifact\n{"kind":"mail_message","id":"gmail_msg_abc","title":"Photos"}\n```';
    expect(splitArtifactBlocks(text)).toEqual([{ type: "artifact", artifact: { kind: "mail_message", id: "gmail_msg_abc", title: "Photos" } }]);
  });
  it("round-trips safe message paths only", () => {
    expect(parseMailMessagePath(mailMessagePath("gmail_msg_1"))).toBe("gmail_msg_1");
    expect(parseMailMessagePath("~mail/message/../x")).toBeNull();
    expect(parseMailMessagePath("~mail/draft/abc")).toBeNull();
  });
});
