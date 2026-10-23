import { describe, expect, it } from "vitest";
import { hasHostAccess, requiresHostAccess } from "./app-capabilities";

describe("host capabilities", () => {
  it("does not turn an authenticated email into a host administrator", () => {
    expect(hasHostAccess({ email: "sean@rebattery.io" })).toBe(false);
    expect(hasHostAccess({ email: "ari@rebattery.io.evil.example" })).toBe(false);
    expect(hasHostAccess({ email: "ari@rebattery.io" })).toBe(true);
  });

  it.each([
    "/api/workspace/execute", "/api/workspace/query", "/api/workspace/db/introspect",
    "/api/workspace/list", "/api/workspace/tree", "/api/workspace/search-index",
    "/api/workspace/suggest-files", "/api/workspace/upload", "/api/workspace/virtual-file",
    "/api/workspace/reports/execute", "/api/workspace/write-binary", "/api/workspace/watch",
    "/api/workspace/objects/person/actions/runs", "/api/workspace/new-host-feature",
    "/api/terminal/port/", "/api/%74erminal/port", "/api/workspace%2Fraw-file",
    "/api/workspace/objects/person/entries/../actions", "/api/workspace/objects/person/entries/%2e%2e/actions",
    "/api/workspace/%broken", "/api/workspace\\raw-file",
  ])("restricts direct and encoded privileged paths: %s", path => {
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      expect(requiresHostAccess(path, method)).toBe(true);
    }
  });

  it("requires admin for object registration but preserves scoped entry/view operations", () => {
    expect(requiresHostAccess("/api/workspace/objects", "POST")).toBe(true);
    expect(requiresHostAccess("/api/workspace/objects/person", "DELETE")).toBe(true);
    expect(requiresHostAccess("/api/workspace/objects/person/entries/one", "PATCH")).toBe(false);
    expect(requiresHostAccess("/api/workspace/objects/person/views", "POST")).toBe(false);
    expect(requiresHostAccess("/api/workspace/objects", "GET")).toBe(false);
  });

  it("matches complete prefixes, not similarly named routes", () => {
    expect(requiresHostAccess("/api/settings-copy", "GET")).toBe(false);
    expect(requiresHostAccess("/api/workspace-copy", "GET")).toBe(false);
  });
});
