import { describe, expect, it } from "vitest";
import { rawFileLinkPath } from "./raw-file-link";

const HOST = "crm.rebattery.io";

describe("rawFileLinkPath", () => {
  it("returns the workspace path for an absolute link on this app's host", () => {
    expect(rawFileLinkPath("https://crm.rebattery.io/api/workspace/raw-file?path=/root/.hermes/workspace/qa-evidence/run/a.webm", HOST))
      .toBe("/root/.hermes/workspace/qa-evidence/run/a.webm");
  });
  it("accepts a relative link and decodes the path", () => {
    expect(rawFileLinkPath("/api/workspace/raw-file?path=notes%2Fmy%20clip.mp4", HOST)).toBe("notes/my clip.mp4");
  });
  it("ignores links to other hosts, other routes and missing paths", () => {
    expect(rawFileLinkPath("https://evil.example/api/workspace/raw-file?path=/etc/passwd", HOST)).toBeNull();
    expect(rawFileLinkPath("https://crm.rebattery.io/api/workspace/file?path=a.mp4", HOST)).toBeNull();
    expect(rawFileLinkPath("https://crm.rebattery.io/api/workspace/raw-file", HOST)).toBeNull();
    expect(rawFileLinkPath("not a url", HOST)).toBeNull();
    expect(rawFileLinkPath("", HOST)).toBeNull();
  });
  it("is case-insensitive about the host", () => {
    expect(rawFileLinkPath("https://CRM.rebattery.io/api/workspace/raw-file?path=a.mp4", HOST)).toBe("a.mp4");
  });
});
