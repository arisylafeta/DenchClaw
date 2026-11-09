import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[][] = [];
vi.mock("node:child_process", () => {
  const execFile = (_cmd: string, args: string[], _opts: unknown, cb: (e: Error | null, r: { stdout: string; stderr: string }) => void) => { calls.push(args); cb(null, { stdout: "{}", stderr: "" }); };
  return { execFile, default: { execFile } };
});

import { editDraft } from "./mail-draft-actions";

const draft = { id: "d1", state: "draft", subject: "Re: x", body_text: "Hi", identity_key: "alex", to_emails: ["christoph@b.co"], cc_emails: ["matt@p.energy"], bcc_emails: [] } as never;

describe("editDraft recipients", () => {
  beforeEach(() => { calls.length = 0; });
  it("replaces the To list through the mail CLI, lower-cased and sorted", async () => {
    await editDraft(draft, { to: ["Matt@P.energy"], cc: [] });
    expect(calls).toEqual([["edit", "--to=matt@p.energy", "--cc=", "--expect-identity=alex", "--", "d1"]]);
  });
  it("does not call the CLI when To is unchanged", async () => {
    await editDraft(draft, { to: ["christoph@b.co"] });
    expect(calls).toEqual([]);
  });
  it("refuses an empty To list", async () => {
    await expect(editDraft(draft, { to: [" "] })).rejects.toThrow("at least one To address");
    expect(calls).toEqual([]);
  });
});

describe("editDraft address checks", () => {
  it("rejects a malformed To before calling the CLI", async () => {
    calls.length = 0;
    await expect(editDraft(draft, { to: ["not-an-address"] })).rejects.toMatchObject({ status: 400 });
    expect(calls).toEqual([]);
  });
});
