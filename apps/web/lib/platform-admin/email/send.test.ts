import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const sendEmail = vi.fn();
vi.mock("./client", () => ({ getPostmarkClient: () => ({ sendEmail }) }));
vi.mock("@/lib/platform-admin/env", () => ({ getPostmarkEnv: () => ({ postmarkFromEmail: "hello@rebattery.io" }) }));

const { sendRawEmail, postmarkStop } = await import("./send");

describe("Postmark emergency stop", () => {
  afterEach(() => { delete process.env.REBATTERY_MAIL_POSTMARK_STOP_FILE; sendEmail.mockReset(); });

  it("sends nothing while the stop file exists, and says who stopped it", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "pm-stop-")), "stop.json");
    writeFileSync(file, JSON.stringify({ by: "Alex", reason: "wrong price" }));
    process.env.REBATTERY_MAIL_POSTMARK_STOP_FILE = file;
    const result = await sendRawEmail({ to: "a@example.test", subject: "s", html: "<p>x</p>" });
    expect(result).toEqual({ success: false, error: "stopped", detail: "Postmark sending is stopped by Alex: wrong price" });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("an unreadable stop file still stops; no file, no stop", () => {
    const file = join(mkdtempSync(join(tmpdir(), "pm-stop-")), "stop.json");
    writeFileSync(file, "not json");
    process.env.REBATTERY_MAIL_POSTMARK_STOP_FILE = file;
    expect(postmarkStop()).toEqual({ reason: "stop file present" });
    process.env.REBATTERY_MAIL_POSTMARK_STOP_FILE = join(tmpdir(), "does-not-exist-pm-stop.json");
    expect(postmarkStop()).toBeNull();
  });
});
