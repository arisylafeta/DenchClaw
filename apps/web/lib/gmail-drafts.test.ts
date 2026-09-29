import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("node:child_process", async (original) => ({ ...(await original<typeof import("node:child_process")>()), execFile }));

describe("createGmailDraft", () => {
  it("passes the restriction flags and the body on stdin", async () => {
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
    const options = execFile.mock.calls[0][2] as { env: NodeJS.ProcessEnv };
    expect(options.env).toBeDefined();
  });
});

// Checks the real gog CLI enforces the restriction, using --dry-run so Gmail is never contacted.
// Opt in with GOG_SAFETY_TEST=1 and GOG_SAFETY_ACCOUNT=<an authorised account>.
describe.skipIf(process.env.GOG_SAFETY_TEST !== "1")("gog restriction (real CLI, dry run)", () => {
  const account = process.env.GOG_SAFETY_ACCOUNT ?? "";
  const gog = (...command: string[]) => execFileSync(process.env.GOG_BIN || "gog", [
    "--account", account, "--gmail-no-send", "--enable-commands-exact", "gmail.drafts.create",
    "--no-input", "--json", "--dry-run", ...command,
  ], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], input: "Body" });

  it("allows draft creation", () => {
    expect(JSON.parse(gog("gmail", "drafts", "create", "--subject", "Safety check", "--body-file", "-"))).toMatchObject({
      dry_run: true, op: "gmail.drafts.create",
    });
  });

  it("refuses to send", () => {
    expect(() => gog("gmail", "send", "--to", "nobody@example.test", "--subject", "x", "--body", "y")).toThrow(/not enabled/);
  });
});

