import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const fsFiles = new Map<string, Buffer>([["/kr/token", Buffer.from("old")]]);
vi.mock("node:fs", () => ({
  readFileSync: (p: string) => { const b = fsFiles.get(p); if (!b) throw new Error("ENOENT"); return b; },
  readdirSync: () => [...fsFiles.keys()].filter((k) => k.startsWith("/kr/")).map((k) => k.slice(4)),
  statSync: () => ({ isFile: () => true }),
  writeFileSync: (p: string, b: Buffer) => { fsFiles.set(p, b); },
}));
process.env.GOG_KEYRING_DIR = "/kr";
process.env.GOG_KEYRING_PASSWORD = "x";
const calls: string[][] = [];
let respond: (args: string[]) => { stdout?: string; error?: { stderr: string } } = () => ({ stdout: "{}" });
vi.mock("node:child_process", () => ({
  execFile: (_bin: string, args: string[], _opts: unknown, cb: (err: unknown, out?: { stdout: string; stderr: string }) => void) => {
    calls.push(args);
    const r = respond(args);
    if (r.error) cb(Object.assign(new Error("fail"), r.error)); else cb(null, { stdout: r.stdout ?? "{}", stderr: "" });
  },
}));

const { convertTarget, driveConnectFinish, driveConnectUrl, openUrl, uploadToDrive, validRedirect } = await import("./google-drive");

const AUTH_LIST = JSON.stringify({ accounts: [{ email: "alex@rebattery.io", scopes: ["https://www.googleapis.com/auth/gmail.send"] }] });

beforeEach(() => { calls.length = 0; respond = () => ({ stdout: "{}" }); });

describe("google drive helpers", () => {
  it("converts Office files only", () => {
    expect(convertTarget("Advisor agreement.docx")).toBe("doc");
    expect(convertTarget("stock.XLSX")).toBe("sheet");
    expect(convertTarget("deck.pptx")).toBe("slides");
    expect(convertTarget("invoice.pdf")).toBeNull();
    expect(convertTarget("noext")).toBeNull();
  });

  it("accepts only Google's local callback with a code", () => {
    expect(validRedirect("http://127.0.0.1:37579/oauth2/callback?state=a&code=b&scope=x")).toBe(true);
    expect(validRedirect("http://localhost:1/oauth2/callback?state=a&code=b")).toBe(true);
    expect(validRedirect("https://evil.example/oauth2/callback?state=a&code=b")).toBe(false);
    expect(validRedirect("http://127.0.0.1:1/oauth2/callback?state=a")).toBe(false);
    expect(validRedirect("not a url")).toBe(false);
  });

  it("builds an editor link for converted files", () => {
    expect(openUrl({ id: "X", mimeType: "application/vnd.google-apps.document" })).toBe("https://docs.google.com/document/d/X/edit");
    expect(openUrl({ id: "X" })).toBe("https://drive.google.com/file/d/X/view");
    expect(openUrl({ id: "X", webViewLink: "https://docs.google.com/x" })).toBe("https://docs.google.com/x");
  });
});

describe("uploadToDrive", () => {
  it("reuses the Relay attachments folder and converts a docx to a Doc without the extension", async () => {
    respond = (args) => args.includes("search") ? { stdout: JSON.stringify({ files: [{ id: "F1" }] }) }
      : args.includes("upload") ? { stdout: JSON.stringify({ file: { id: "D1", mimeType: "application/vnd.google-apps.document" } }) } : { stdout: "{}" };
    const r = await uploadToDrive("alex@rebattery.io", "/tmp/x", "Advisor agreement.docx");
    expect(r).toEqual({ url: "https://docs.google.com/document/d/D1/edit", name: "Advisor agreement", converted: true });
    const upload = calls.find((c) => c.includes("upload"))!;
    expect(upload).toEqual(expect.arrayContaining(["--account", "alex@rebattery.io", "--enable-commands", "drive", "--parent", "F1", "--convert-to", "doc", "--name", "Advisor agreement"]));
    expect(calls.some((c) => c.includes("mkdir"))).toBe(false);
  });

  it("creates the folder when missing and uploads a PDF as is", async () => {
    respond = (args) => args.includes("search") ? { stdout: JSON.stringify({ files: [] }) }
      : args.includes("mkdir") ? { stdout: JSON.stringify({ file: { id: "F2" } }) }
      : { stdout: JSON.stringify({ file: { id: "P1", webViewLink: "https://drive.google.com/file/d/P1/view" } }) };
    const r = await uploadToDrive("alex@rebattery.io", "/tmp/x", "invoice.pdf");
    expect(r.converted).toBe(false);
    expect(calls.find((c) => c.includes("upload"))).not.toContain("--convert-to");
  });

  it("reports a missing Drive scope as not connected", async () => {
    respond = () => ({ error: { stderr: "Google API error (403 insufficientPermissions): Request had insufficient authentication scopes." } });
    await expect(uploadToDrive("alex@rebattery.io", "/tmp/x", "a.pdf")).rejects.toMatchObject({ code: "drive_not_connected" });
  });
});

describe("connect", () => {
  it("refuses an account the server has no login for", async () => {
    respond = () => ({ stdout: AUTH_LIST });
    await expect(driveConnectUrl("someone@else.com")).rejects.toMatchObject({ code: "bad_account" });
  });

  it("keeps Gmail send when asking for Drive", async () => {
    respond = (args) => args.includes("list") ? { stdout: AUTH_LIST } : { stdout: JSON.stringify({ auth_url: "https://accounts.google.com/o/oauth2/auth?x" }) };
    await driveConnectUrl("alex@rebattery.io");
    const step1 = calls.find((c) => c.includes("--step"))!;
    expect(step1).toEqual(expect.arrayContaining(["--services", "gmail,calendar,drive", "--extra-scopes", "https://www.googleapis.com/auth/gmail.send"]));
  });

  it("puts the old login back when Gmail send was unticked", async () => {
    let listed = 0;
    respond = (args) => {
      if (args.includes("list")) { listed++; return { stdout: listed === 1 ? AUTH_LIST : JSON.stringify({ accounts: [{ email: "alex@rebattery.io", scopes: ["https://www.googleapis.com/auth/drive", "https://www.googleapis.com/auth/gmail.modify"] }] }) }; }
      fsFiles.set("/kr/token", Buffer.from("new"));
      return { stdout: "{}" };
    };
    await expect(driveConnectFinish("alex@rebattery.io", "http://127.0.0.1:1/oauth2/callback?state=a&code=b")).rejects.toMatchObject({ code: "drive_not_connected" });
    expect(fsFiles.get("/kr/token")?.toString()).toBe("old");
  });

  it("keeps the new login when every scope came through", async () => {
    let listed = 0;
    respond = (args) => {
      if (args.includes("list")) { listed++; return { stdout: listed === 1 ? AUTH_LIST : JSON.stringify({ accounts: [{ email: "alex@rebattery.io", scopes: ["https://www.googleapis.com/auth/drive", "https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/gmail.send"] }] }) }; }
      fsFiles.set("/kr/token", Buffer.from("new"));
      return { stdout: "{}" };
    };
    await driveConnectFinish("alex@rebattery.io", "http://127.0.0.1:1/oauth2/callback?state=a&code=b");
    expect(fsFiles.get("/kr/token")?.toString()).toBe("new");
  });

  it("refuses a pasted address that isn't the callback, without calling Google", async () => {
    respond = () => ({ stdout: AUTH_LIST });
    await expect(driveConnectFinish("alex@rebattery.io", "https://example.com")).rejects.toMatchObject({ code: "bad_redirect" });
    expect(calls.some((c) => c.includes("--step"))).toBe(false);
  });
});
