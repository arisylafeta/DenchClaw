import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverWorkspaces } from "@/lib/workspace";
import { GET } from "./route";

vi.mock("@/lib/workspace", () => ({ discoverWorkspaces: vi.fn() }));

let root: string;
beforeEach(async () => {
  vi.stubEnv("DENCH_AGENT_BACKEND", "hermes");
  root = await mkdtemp(join(process.env.TMPDIR || tmpdir(), "profile-avatar-"));
  vi.mocked(discoverWorkspaces).mockReturnValue([
    { name: "default", stateDir: root, workspaceDir: join(root, "workspace"), isActive: true, hasConfig: true },
    { name: "investigator", stateDir: join(root, "profiles/investigator"), workspaceDir: null, isActive: false, hasConfig: true },
  ]);
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

function request(name: string) { return new Request(`http://localhost/api/workspace/avatar?name=${encodeURIComponent(name)}`); }

it.each(["default", "investigator"])("serves the existing %s profile avatar", async (name) => {
  const profile = discoverWorkspaces().find((item) => item.name === name)!;
  await mkdir(join(profile.stateDir, "assets"), { recursive: true });
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  await writeFile(join(profile.stateDir, "assets/avatar.png"), bytes);
  const response = await GET(request(name));
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("image/png");
  expect(response.headers.get("Cache-Control")).toBe("private, no-cache");
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
});

it.each(["", "../default", "/root/.hermes", "unknown"])("rejects unknown or invalid name %s", async (name) => {
  expect((await GET(request(name))).status).toBe(404);
});
it("returns 404 for a missing avatar", async () => { expect((await GET(request("default"))).status).toBe(404); });
it("does not serve Hermes avatars for another backend", async () => {
  vi.stubEnv("DENCH_AGENT_BACKEND", "openclaw");
  expect((await GET(request("default"))).status).toBe(404);
});
