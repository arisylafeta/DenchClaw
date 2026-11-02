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

import { chatImageSource } from "./raw-file-link";
describe("chatImageSource", () => {
  it("serves local image paths through the raw-file route and leaves web sources alone", () => {
    expect(chatImageSource("/root/.hermes/workspace/a%20b.png")).toEqual({ src: "/api/workspace/raw-file?path=%2Froot%2F.hermes%2Fworkspace%2Fa%20b.png", path: "/root/.hermes/workspace/a b.png" });
    expect(chatImageSource("file:///tmp/x%20y.png")).toEqual({ src: "/api/workspace/raw-file?path=%2Ftmp%2Fx%20y.png", path: "/tmp/x y.png" });
    expect(chatImageSource("reports/chart.PNG").path).toBe("reports/chart.PNG");
    expect(chatImageSource("https://example.test/a.png")).toEqual({ src: "https://example.test/a.png", path: null });
    expect(chatImageSource("data:image/png;base64,AAAA").path).toBeNull();
  });
  it("keeps a literal % in a file name and decodes non-ASCII parser escapes", () => {
    expect(chatImageSource("/root/a%41.png").path).toBe("/root/a%41.png");
    expect(chatImageSource("/root/a%2541.png").path).toBe("/root/a%2541.png");
    expect(chatImageSource("/root/caf%C3%A9.png").path).toBe("/root/café.png");
  });
  it("opens own raw-file URLs by path and refuses everything else", () => {
    expect(chatImageSource("/api/workspace/raw-file?path=%2Fws%2Fa.png")).toEqual({ src: "/api/workspace/raw-file?path=%2Fws%2Fa.png", path: "/ws/a.png" });
    expect(chatImageSource("https://crm.test/api/workspace/raw-file?path=%2Fws%2Fa.png", "crm.test").path).toBe("/ws/a.png");
    expect(chatImageSource("https://crm.test/api/auth/logout", "crm.test")).toEqual({ src: "", path: null });
    expect(chatImageSource("https://crm.test/api/workspace/raw-file?path=%2Froot%2Fsecret.txt", "crm.test")).toEqual({ src: "", path: null });
    expect(chatImageSource("https://other.test/api/auth/logout", "crm.test")).toEqual({ src: "https://other.test/api/auth/logout", path: null });
    expect(chatImageSource("file://localhost/tmp/a.png").path).toBe("/tmp/a.png");
    for (const bad of ["", "/api/auth/session", "//cdn.test/a.png", "javascript:alert(1)", "C:\\x\\a.png", "ftp://h/a.png", "/root/report.html", "/root/secret.txt", "data:text/html,x", "/api/workspace/raw-file?path=%2Froot%2Fa.html", "file://evil.host/share/a.png", "/root/x.png?v=1"]) {
      expect(chatImageSource(bad)).toEqual({ src: "", path: null });
    }
  });
});
