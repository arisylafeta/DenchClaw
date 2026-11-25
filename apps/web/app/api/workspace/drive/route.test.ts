import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ user: { id: "u1", email: "alex@rebattery.io" } as { id: string; email: string } | null }));
const drive = vi.hoisted(() => ({ connected: true, upload: vi.fn() }));
vi.mock("@/lib/auth", () => ({ currentUser: async () => auth.user }));
vi.mock("@/lib/google-drive", () => {
  class DriveError extends Error { constructor(public code: string, message: string) { super(message); } }
  return { DriveError, driveConnected: async () => drive.connected, uploadToDrive: drive.upload };
});

import { POST } from "./route";

let dir: string;
const post = (body: unknown) => POST(new Request("http://x/api/workspace/drive", { method: "POST", body: JSON.stringify(body) }));

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "ws-drive-"));
  await writeFile(path.join(dir, "Open orders.xlsx"), "xlsx bytes");
  await writeFile(path.join(dir, "notes.sh"), "echo");
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });
beforeEach(() => { auth.user = { id: "u1", email: "alex@rebattery.io" }; drive.connected = true; drive.upload.mockReset(); });

describe("POST /api/workspace/drive", () => {
  it("uploads the file to the signed-in user's Drive under its own name", async () => {
    drive.upload.mockResolvedValue({ url: "https://docs.google.com/spreadsheets/d/1/edit", name: "Open orders", converted: true });
    const response = await post({ path: path.join(dir, "Open orders.xlsx") });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ converted: true });
    expect(drive.upload).toHaveBeenCalledWith("alex@rebattery.io", path.join(dir, "Open orders.xlsx"), "Open orders.xlsx");
  });

  it("asks to connect Drive first, and refuses signed-out users, missing files and non-documents", async () => {
    drive.connected = false;
    expect((await post({ path: path.join(dir, "Open orders.xlsx") })).status).toBe(409);
    drive.connected = true;
    expect((await post({ path: path.join(dir, "missing.xlsx") })).status).toBe(404);
    expect((await post({ path: path.join(dir, "notes.sh") })).status).toBe(400);
    expect((await post({})).status).toBe(404);
    auth.user = null;
    expect((await post({ path: path.join(dir, "Open orders.xlsx") })).status).toBe(401);
    expect(drive.upload).not.toHaveBeenCalled();
  });
});
