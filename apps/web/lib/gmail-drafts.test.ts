import { describe, expect, it, vi } from "vitest";

const execFile = vi.fn();
vi.mock("node:child_process", () => ({ execFile }));

describe("createGmailDraft", () => {
  it("runs gog limited to draft creation with sending blocked, body on stdin", async () => {
    let stdin = "";
    execFile.mockImplementation((_bin: string, _args: string[], _opts: unknown, done: (e: null, out: string) => void) => {
      setTimeout(() => done(null, JSON.stringify({ draft: { id: "r1", message: { id: "m1" } } })));
      return { stdin: { end: (text: string) => { stdin = text; } } };
    });
    const { createGmailDraft } = await import("./gmail-drafts");

    const created = await createGmailDraft("alex@rebattery.io", { to: ["sam@example.test"], subject: "eBS37", body: "Hi Sam" });

    const args: string[] = execFile.mock.calls[0][1];
    expect(args.slice(0, 6)).toEqual(["--account", "alex@rebattery.io", "--gmail-no-send", "--enable-commands-exact", "gmail.drafts.create", "--no-input"]);
    expect(args).toEqual(expect.arrayContaining(["gmail", "drafts", "create", "--to", "sam@example.test"]));
    expect(args).not.toContain("send");
    expect(stdin).toBe("Hi Sam");
    expect(created).toEqual({ draftId: "r1", messageId: "m1" });
  });
});
