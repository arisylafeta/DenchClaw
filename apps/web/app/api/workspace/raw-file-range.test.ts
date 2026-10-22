import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
describe("GET /api/workspace/raw-file ranges", () => {
  let dir: string;
  beforeEach(async () => {
    vi.resetModules();
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    dir = mkdtempSync(join(tmpdir(), "raw-range-"));
    writeFileSync(join(dir, "clip.mp4"), Buffer.from("0123456789"));
    vi.doMock("@/lib/workspace", () => ({
      resolveFilesystemPath: vi.fn(() => ({ absolutePath: join(dir, "clip.mp4"), kind: "workspaceRelative", withinWorkspace: true, workspaceRelativePath: "clip.mp4" })),
      resolveWorkspaceRoot: vi.fn(() => dir),
      isProtectedSystemPath: vi.fn(() => false),
    }));
  });
  afterEach(async () => {
    const { rmSync } = await import("node:fs");
    rmSync(dir, { recursive: true, force: true });
  });
  const get = async (range?: string) => {
    const { GET } = await import("./raw-file/route.js");
    return GET(new Request("http://localhost/api/workspace/raw-file?path=clip.mp4", range ? { headers: { range } } : undefined));
  };

  it("advertises byte ranges and serves the whole file inline without one", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(res.headers.get("Content-Length")).toBe("10");
    expect(res.headers.get("Content-Disposition")).toBe("inline");
    expect(await res.text()).toBe("0123456789");
  });
  it("serves a partial range with 206 and Content-Range", async () => {
    const res = await get("bytes=2-5");
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 2-5/10");
    expect(res.headers.get("Content-Length")).toBe("4");
    expect(await res.text()).toBe("2345");
  });
  it("serves an open-ended and a suffix range", async () => {
    const open = await get("bytes=7-");
    expect(open.status).toBe(206);
    expect(await open.text()).toBe("789");
    const suffix = await get("bytes=-3");
    expect(suffix.status).toBe(206);
    expect(await suffix.text()).toBe("789");
  });
  it("clamps an end past the file and rejects an unsatisfiable start with 416", async () => {
    const clamped = await get("bytes=8-99");
    expect(clamped.status).toBe(206);
    expect(clamped.headers.get("Content-Range")).toBe("bytes 8-9/10");
    const bad = await get("bytes=50-60");
    expect(bad.status).toBe(416);
    expect(bad.headers.get("Content-Range")).toBe("bytes */10");
  });
  it("ignores a malformed Range header and serves the whole file", async () => {
    const res = await get("items=1-2");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("0123456789");
  });
});


