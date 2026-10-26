import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileResponse, readDraftFile } from "./mail-draft-files";

let root = ""; let outside = "";
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "store-")); outside = await mkdtemp(path.join(os.tmpdir(), "outside-")); await mkdir(path.join(root, "m1")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });

describe("readDraftFile", () => {
  it("reads a file inside the store when its checksum matches", async () => {
    const file = path.join(root, "m1", "a.jpg"); await writeFile(file, "jpegbytes");
    const result = await readDraftFile({ path: file, filename: "a.jpg", mediaType: "image/jpeg" }, sha("jpegbytes"), root);
    expect(result?.bytes.toString()).toBe("jpegbytes");
  });
  it("refuses a path outside the store, including through a symlink", async () => {
    const secret = path.join(outside, "secret.txt"); await writeFile(secret, "x");
    expect(await readDraftFile({ path: secret, filename: "s", mediaType: null }, sha("x"), root)).toBeNull();
    await symlink(secret, path.join(root, "m1", "link")); 
    expect(await readDraftFile({ path: path.join(root, "m1", "link"), filename: "s", mediaType: null }, sha("x"), root)).toBeNull();
  });
  it("refuses a file that no longer matches its recorded checksum, and a missing file", async () => {
    const file = path.join(root, "m1", "a.jpg"); await writeFile(file, "changed");
    expect(await readDraftFile({ path: file, filename: "a.jpg", mediaType: null }, sha("original"), root)).toBeNull();
    expect(await readDraftFile({ path: path.join(root, "m1", "gone"), filename: "g", mediaType: null }, sha("x"), root)).toBeNull();
  });
});

describe("fileResponse", () => {
  const file = (mediaType: string | null) => ({ bytes: Buffer.from("x"), filename: 'we"ird é.jpg', mediaType });
  it("shows only safe image types inline and only when asked", () => {
    expect(fileResponse(file("image/jpeg"), true).headers.get("content-type")).toBe("image/jpeg");
    expect(fileResponse(file("image/jpeg"), true).headers.get("content-disposition")).toMatch(/^inline;/);
    expect(fileResponse(file("image/jpeg"), false).headers.get("content-disposition")).toMatch(/^attachment;/);
    for (const type of ["image/svg+xml", "text/html", "application/pdf", null]) {
      const res = fileResponse(file(type), true);
      expect(res.headers.get("content-type")).toBe("application/octet-stream");
      expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
    }
    expect(fileResponse(file("image/png"), true).headers.get("x-content-type-options")).toBe("nosniff");
  });
});
