import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({ root: "" }));
vi.mock("@/lib/workspace", () => ({
  resolveWorkspaceRoot: () => state.root,
  safeResolveNewPath: (path: string) => join(state.root, path),
}));
vi.mock("@/lib/telemetry", () => ({ trackServer: vi.fn() }));
import { POST } from "./route";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");
afterEach(() => { if (state.root) rmSync(state.root, { recursive: true, force: true }); });
describe("workspace attachment ingestion", () => {
  it("persists a synthetic PNG received as browser multipart bytes", async () => {
    state.root = mkdtempSync(join(tmpdir(), "chat-png-"));
    const form = new FormData();
    form.append("file", new File([png], "synthetic.png", { type: "image/png" }));
    const response = await POST(new NextRequest("http://localhost/api/workspace/upload", { method: "POST", body: form }));
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({ ok: true, path: expect.stringMatching(/^assets\/\d+-synthetic\.png$/) });
    expect(readFileSync(join(state.root, body.path))).toEqual(png);
  });

  it.each([
    [null, "Missing 'file' field"],
    [new File([new Uint8Array(25 * 1024 * 1024 + 1)], "large.png", { type: "image/png" }), "File is too large (max 25 MB)"],
  ])("rejects invalid uploads without writing an attachment", async (file, error) => {
    state.root = mkdtempSync(join(tmpdir(), "chat-png-"));
    const form = new FormData();
    if (file) form.append("file", file);
    const response = await POST(new NextRequest("http://localhost/api/workspace/upload", { method: "POST", body: form }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error });
    expect(readdirSync(state.root)).toEqual([]);
  });
});
