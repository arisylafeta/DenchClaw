import { describe, it, expect } from "vitest";
import {
  buildEntryLink,
  buildFileLink,
  buildChatLink,
  buildSubagentLink,
  buildBrowseLink,
  buildUrl,
  parseWorkspaceLink,
  parseUrlState,
  serializeUrlState,
  migrateWorkspaceUrl,
  isWorkspaceLink,
  isInternalLink,
  isEntryLink,
} from "./workspace-links";

// ─── buildEntryLink ────────────────────────────────────────────────

describe("buildEntryLink", () => {
  it("builds a basic entry link at root route", () => {
    expect(buildEntryLink("leads", "abc123")).toBe("/?entry=leads:abc123");
  });

  it("encodes special characters in object name", () => {
    const result = buildEntryLink("my objects", "id1");
    expect(result).toContain("my%20objects");
    expect(result).toContain("id1");
  });

  it("encodes special characters in entry ID", () => {
    const result = buildEntryLink("leads", "id/with/slashes");
    expect(result).toContain("id%2Fwith%2Fslashes");
  });

  it("handles empty object name", () => {
    const result = buildEntryLink("", "id1");
    expect(result).toBe("/?entry=:id1");
  });

  it("handles unicode characters", () => {
    const result = buildEntryLink("対象", "エントリ");
    expect(result).toContain("/?entry=");
    const url = new URL(result, "http://localhost");
    expect(url.searchParams.get("entry")).toBe("対象:エントリ");
  });
});

// ─── buildFileLink ────────────────────────────────────────────────

describe("buildFileLink", () => {
  it("builds a basic file link at root route", () => {
    expect(buildFileLink("knowledge/doc.md")).toBe("/?path=knowledge%2Fdoc.md");
  });

  it("builds link for nested path", () => {
    const result = buildFileLink("a/b/c/d.txt");
    const url = new URL(result, "http://localhost");
    expect(url.searchParams.get("path")).toBe("a/b/c/d.txt");
  });

  it("handles spaces in path", () => {
    const result = buildFileLink("my docs/file name.md");
    const url = new URL(result, "http://localhost");
    expect(url.searchParams.get("path")).toBe("my docs/file name.md");
  });

  it("handles special characters", () => {
    const result = buildFileLink("notes & ideas/doc (1).md");
    const url = new URL(result, "http://localhost");
    expect(url.searchParams.get("path")).toBe("notes & ideas/doc (1).md");
  });

  it("handles empty path", () => {
    expect(buildFileLink("")).toBe("/?path=");
  });
});

// ─── buildChatLink ────────────────────────────────────────────────

describe("buildChatLink", () => {
  it("builds a chat session link", () => {
    expect(buildChatLink("sess-123")).toBe("/?chat=sess-123");
  });
});

// ─── buildSubagentLink ────────────────────────────────────────────

describe("buildSubagentLink", () => {
  it("includes both chat and subagent params", () => {
    const result = buildSubagentLink("parent-id", "child-key");
    expect(result).toBe("/?chat=parent-id&subagent=child-key");
  });
});

// ─── buildBrowseLink ──────────────────────────────────────────────

describe("buildBrowseLink", () => {
  it("builds browse link for an absolute directory", () => {
    const result = buildBrowseLink("/Users/me/Desktop");
    expect(result).toContain("browse=");
    const url = new URL(result, "http://localhost");
    expect(url.searchParams.get("browse")).toBe("/Users/me/Desktop");
  });

  it("includes hidden flag when requested", () => {
    const result = buildBrowseLink("/tmp", true);
    const url = new URL(result, "http://localhost");
    expect(url.searchParams.get("hidden")).toBe("1");
  });
});

// ─── parseWorkspaceLink ───────────────────────────────────────────

describe("parseWorkspaceLink", () => {
  it.each(["https://foreign.test/?path=readme.md", "//foreign.test/?path=readme.md", "https://crm.rebattery.io@foreign.test/?path=readme.md"])("rejects foreign origins: %s", href => {
    expect(parseWorkspaceLink(href)).toBeNull();
    expect(isWorkspaceLink(href)).toBe(false);
  });
  it("parses file link from root route path param", () => {
    const result = parseWorkspaceLink("/?path=knowledge/doc.md");
    expect(result).toEqual({ kind: "file", path: "knowledge/doc.md" });
  });

  it("parses entry link from root route entry param", () => {
    const result = parseWorkspaceLink("/?entry=leads:abc123");
    expect(result).toEqual({ kind: "entry", objectName: "leads", entryId: "abc123" });
  });

  it("parses entry link from full URL", () => {
    const result = parseWorkspaceLink("https://crm.rebattery.io/?entry=deals:xyz");
    expect(result).toEqual({ kind: "entry", objectName: "deals", entryId: "xyz" });
  });

  it("parses file link from full URL", () => {
    const result = parseWorkspaceLink("https://crm.rebattery.io/?path=readme.md");
    expect(result).toEqual({ kind: "file", path: "readme.md" });
  });

  it("parses legacy /workspace file link (backward compat)", () => {
    const result = parseWorkspaceLink("/workspace?path=knowledge/doc.md");
    expect(result).toEqual({ kind: "file", path: "knowledge/doc.md" });
  });

  it("parses legacy /workspace entry link (backward compat)", () => {
    const result = parseWorkspaceLink("/workspace?entry=leads:abc123");
    expect(result).toEqual({ kind: "entry", objectName: "leads", entryId: "abc123" });
  });

  it("parses legacy @entry/ format", () => {
    const result = parseWorkspaceLink("@entry/leads/abc123");
    expect(result).toEqual({ kind: "entry", objectName: "leads", entryId: "abc123" });
  });

  it("returns null for invalid URL", () => {
    expect(parseWorkspaceLink("not a url ://bad")).toBeNull();
  });

  it("returns null when no params present on root", () => {
    expect(parseWorkspaceLink("/")).toBeNull();
  });

  it("returns null for hash-only link", () => {
    expect(parseWorkspaceLink("/#section")).toBeNull();
  });

  it("returns null for entry param without colon", () => {
    expect(parseWorkspaceLink("/?entry=nocolon")).toBeNull();
  });

  it("handles deeply nested file path", () => {
    const result = parseWorkspaceLink("/?path=a/b/c/d/e/f.txt");
    expect(result).toEqual({ kind: "file", path: "a/b/c/d/e/f.txt" });
  });

  it("handles encoded characters in path", () => {
    const result = parseWorkspaceLink("/?path=my%20docs%2Ffile.md");
    expect(result).toEqual({ kind: "file", path: "my docs/file.md" });
  });

  it("returns null for non-workspace URL", () => {
    expect(parseWorkspaceLink("https://google.com")).toBeNull();
  });

  it("entry param takes priority over path param", () => {
    const result = parseWorkspaceLink("/?entry=obj:id&path=file.md");
    expect(result).toEqual({ kind: "entry", objectName: "obj", entryId: "id" });
  });

  it("handles entry with colon in ID", () => {
    const result = parseWorkspaceLink("/?entry=obj:id:with:colons");
    expect(result).toEqual({ kind: "entry", objectName: "obj", entryId: "id:with:colons" });
  });

  it("returns null for legacy @entry with no slash after object name", () => {
    expect(parseWorkspaceLink("@entry/objectonly")).toBeNull();
  });
});

// ─── isWorkspaceLink ──────────────────────────────────────────────

describe("isWorkspaceLink", () => {
  it("returns true for /?path=...", () => {
    expect(isWorkspaceLink("/?path=doc.md")).toBe(true);
  });

  it("returns true for /#...", () => {
    expect(isWorkspaceLink("/#section")).toBe(true);
  });

  it("returns true for / alone", () => {
    expect(isWorkspaceLink("/")).toBe(true);
  });

  it("returns true for @entry/ format", () => {
    expect(isWorkspaceLink("@entry/leads/abc")).toBe(true);
  });

  it("returns true for legacy /workspace?path=... (backward compat)", () => {
    expect(isWorkspaceLink("/workspace?path=doc.md")).toBe(true);
  });

  it("returns true for legacy /workspace alone", () => {
    expect(isWorkspaceLink("/workspace")).toBe(true);
  });

  it("returns false for external URL", () => {
    expect(isWorkspaceLink("https://example.com")).toBe(false);
  });

  it("returns false for non-root path", () => {
    expect(isWorkspaceLink("/other-page")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isWorkspaceLink("")).toBe(false);
  });
});

// ─── isInternalLink ───────────────────────────────────────────────

describe("isInternalLink", () => {
  it("returns false for http:// URLs", () => {
    expect(isInternalLink("http://example.com")).toBe(false);
  });

  it("returns false for https:// URLs", () => {
    expect(isInternalLink("https://example.com")).toBe(false);
  });

  it("returns false for mailto: links", () => {
    expect(isInternalLink("mailto:user@example.com")).toBe(false);
  });

  it("returns true for relative paths", () => {
    expect(isInternalLink("/?path=doc.md")).toBe(true);
  });

  it("returns true for @entry/ links", () => {
    expect(isInternalLink("@entry/leads/123")).toBe(true);
  });

  it("returns true for plain text", () => {
    expect(isInternalLink("some-page")).toBe(true);
  });
});

// ─── isEntryLink ──────────────────────────────────────────────────

describe("isEntryLink", () => {
  it("returns true for new format entry link at root", () => {
    expect(isEntryLink("/?entry=leads:abc")).toBe(true);
  });

  it("returns true for legacy /workspace entry link", () => {
    expect(isEntryLink("/workspace?entry=leads:abc")).toBe(true);
  });

  it("returns true for legacy @entry/ format", () => {
    expect(isEntryLink("@entry/leads/abc")).toBe(true);
  });

  it("returns false for file workspace link", () => {
    expect(isEntryLink("/?path=doc.md")).toBe(false);
  });

  it("returns false for external URL", () => {
    expect(isEntryLink("https://example.com")).toBe(false);
  });

  it("returns false for plain root", () => {
    expect(isEntryLink("/")).toBe(false);
  });
});

// ─── migrateWorkspaceUrl ──────────────────────────────────────────

describe("migrateWorkspaceUrl", () => {
  it("migrates /workspace to /", () => {
    expect(migrateWorkspaceUrl("/workspace")).toBe("/");
  });

  it("migrates /workspace?path=doc.md preserving query params", () => {
    expect(migrateWorkspaceUrl("/workspace?path=doc.md")).toBe("/?path=doc.md");
  });

  it("migrates /workspace?chat=abc&entry=obj:id", () => {
    expect(migrateWorkspaceUrl("/workspace?chat=abc&entry=obj:id")).toBe("/?chat=abc&entry=obj:id");
  });

  it("preserves hash fragments", () => {
    expect(migrateWorkspaceUrl("/workspace#section")).toBe("/#section");
  });

  it("preserves both query and hash", () => {
    expect(migrateWorkspaceUrl("/workspace?path=a.md#heading")).toBe("/?path=a.md#heading");
  });

  it("returns null for non-workspace URLs", () => {
    expect(migrateWorkspaceUrl("/other")).toBeNull();
    expect(migrateWorkspaceUrl("https://example.com")).toBeNull();
    expect(migrateWorkspaceUrl("/")).toBeNull();
  });
});

// ─── parseUrlState ────────────────────────────────────────────────

describe("parseUrlState", () => {
  it("parses path from search params", () => {
    const state = parseUrlState("path=knowledge/doc.md");
    expect(state.path).toBe("knowledge/doc.md");
    expect(state.chat).toBeNull();
  });

  it("parses chat session", () => {
    const state = parseUrlState("chat=sess-123");
    expect(state.chat).toBe("sess-123");
    expect(state.path).toBeNull();
  });

  it("parses subagent with parent chat", () => {
    const state = parseUrlState("chat=parent&subagent=child-key");
    expect(state.chat).toBe("parent");
    expect(state.subagent).toBe("child-key");
  });

  it("parses entry param", () => {
    const state = parseUrlState("entry=leads:abc123");
    expect(state.entry).toEqual({ objectName: "leads", entryId: "abc123" });
  });

  it("handles entry with colon in ID", () => {
    const state = parseUrlState("entry=obj:id:with:colons");
    expect(state.entry).toEqual({ objectName: "obj", entryId: "id:with:colons" });
  });

  it("returns null entry for entry param without colon", () => {
    const state = parseUrlState("entry=nocolon");
    expect(state.entry).toBeNull();
  });

  it("parses browse mode", () => {
    const state = parseUrlState("browse=/Users/me/Desktop&hidden=1");
    expect(state.browse).toBe("/Users/me/Desktop");
    expect(state.hidden).toBe(true);
  });

  it("hidden defaults to false", () => {
    const state = parseUrlState("browse=/tmp");
    expect(state.hidden).toBe(false);
  });

  it("parses preview target", () => {
    const state = parseUrlState("path=file.md&preview=other.md");
    expect(state.preview).toBe("other.md");
  });

  it("parses object view params", () => {
    const state = parseUrlState("path=leads&viewType=kanban&view=MyView&search=hello&page=3&pageSize=50&cols=name,email,status");
    expect(state.viewType).toBe("kanban");
    expect(state.view).toBe("MyView");
    expect(state.search).toBe("hello");
    expect(state.page).toBe(3);
    expect(state.pageSize).toBe(50);
    expect(state.cols).toEqual(["name", "email", "status"]);
  });

  it("rejects invalid view types", () => {
    const state = parseUrlState("viewType=invalid");
    expect(state.viewType).toBeNull();
  });

  it("parses base64-encoded filters", () => {
    const fg = { id: "root", conjunction: "and" as const, rules: [{ id: "r1", field: "status", operator: "equals" as const, value: "active" }] };
    const encoded = btoa(JSON.stringify(fg));
    const state = parseUrlState(`filters=${encoded}`);
    expect(state.filters).toEqual(fg);
  });

  it("parses base64-encoded sort rules", () => {
    const rules = [{ field: "name", direction: "asc" as const }];
    const encoded = btoa(JSON.stringify(rules));
    const state = parseUrlState(`sort=${encoded}`);
    expect(state.sort).toEqual(rules);
  });

  it("handles invalid base64 filters gracefully", () => {
    const state = parseUrlState("filters=!!!invalid!!!");
    expect(state.filters).toBeNull();
  });

  it("handles invalid base64 sort gracefully", () => {
    const state = parseUrlState("sort=!!!invalid!!!");
    expect(state.sort).toBeNull();
  });

  it("returns all nulls/defaults for empty search", () => {
    const state = parseUrlState("");
    expect(state.path).toBeNull();
    expect(state.chat).toBeNull();
    expect(state.subagent).toBeNull();
    expect(state.fileChat).toBeNull();
    expect(state.entry).toBeNull();
    expect(state.send).toBeNull();
    expect(state.browse).toBeNull();
    expect(state.hidden).toBe(false);
    expect(state.preview).toBeNull();
    expect(state.view).toBeNull();
    expect(state.viewType).toBeNull();
    expect(state.filters).toBeNull();
    expect(state.search).toBeNull();
    expect(state.sort).toBeNull();
    expect(state.page).toBeNull();
    expect(state.pageSize).toBeNull();
    expect(state.cols).toBeNull();
  });

  it("accepts URLSearchParams directly", () => {
    const params = new URLSearchParams();
    params.set("chat", "s1");
    const state = parseUrlState(params);
    expect(state.chat).toBe("s1");
  });
});

// ─── serializeUrlState ────────────────────────────────────────────

describe("serializeUrlState", () => {
  it("omits null/default values", () => {
    expect(serializeUrlState({})).toBe("");
  });

  it("serializes path only", () => {
    const qs = serializeUrlState({ path: "doc.md" });
    expect(qs).toBe("path=doc.md");
  });

  it("serializes chat and subagent", () => {
    const qs = serializeUrlState({ chat: "parent", subagent: "child" });
    expect(qs).toContain("chat=parent");
    expect(qs).toContain("subagent=child");
  });

  it("serializes entry", () => {
    const qs = serializeUrlState({ entry: { objectName: "leads", entryId: "x" } });
    // URLSearchParams encodes : as %3A in values
    expect(qs).toContain("entry=leads");
    expect(qs).toContain("x");
    // Round-trip must restore the entry
    const parsed = parseUrlState(qs);
    expect(parsed.entry).toEqual({ objectName: "leads", entryId: "x" });
  });

  it("serializes browse with hidden", () => {
    const qs = serializeUrlState({ browse: "/tmp", hidden: true });
    expect(qs).toContain("browse=%2Ftmp");
    expect(qs).toContain("hidden=1");
  });

  it("omits page=1 (default)", () => {
    const qs = serializeUrlState({ page: 1 });
    expect(qs).toBe("");
  });

  it("includes page > 1", () => {
    const qs = serializeUrlState({ page: 3 });
    expect(qs).toBe("page=3");
  });

  it("serializes cols as comma-separated", () => {
    const qs = serializeUrlState({ cols: ["name", "email"] });
    expect(qs).toBe("cols=name%2Cemail");
  });

  it("round-trips through parseUrlState", () => {
    const original: Partial<import("./workspace-links").WorkspaceUrlState> = {
      path: "leads",
      viewType: "kanban",
      search: "hello",
      page: 2,
      pageSize: 50,
      cols: ["name", "email"],
    };
    const qs = serializeUrlState(original);
    const parsed = parseUrlState(qs);
    expect(parsed.path).toBe("leads");
    expect(parsed.viewType).toBe("kanban");
    expect(parsed.search).toBe("hello");
    expect(parsed.page).toBe(2);
    expect(parsed.pageSize).toBe(50);
    expect(parsed.cols).toEqual(["name", "email"]);
  });

  it("round-trips filters through serialize/parse", () => {
    const fg = { id: "root", conjunction: "and" as const, rules: [{ id: "r1", field: "status", operator: "equals" as const, value: "active" }] };
    const qs = serializeUrlState({ filters: fg });
    const parsed = parseUrlState(qs);
    expect(parsed.filters).toEqual(fg);
  });

  it("round-trips sort through serialize/parse", () => {
    const sort = [{ field: "name", direction: "desc" as const }];
    const qs = serializeUrlState({ sort });
    const parsed = parseUrlState(qs);
    expect(parsed.sort).toEqual(sort);
  });
});

// ─── buildUrl ─────────────────────────────────────────────────────

describe("buildUrl", () => {
  it("returns / for empty state", () => {
    expect(buildUrl({})).toBe("/");
  });

  it("builds root URL with query params", () => {
    expect(buildUrl({ path: "doc.md" })).toBe("/?path=doc.md");
  });

  it("builds complex URL with multiple params", () => {
    const url = buildUrl({ chat: "s1", subagent: "sa1" });
    expect(url).toContain("/?");
    expect(url).toContain("chat=s1");
    expect(url).toContain("subagent=sa1");
  });
});

// ─── Cron URL state ──────────────────────────────────────────────

describe("cron URL state round-trips", () => {
  it("parses cron dashboard view from URL", () => {
    const state = parseUrlState("path=~cron&cronView=calendar&cronCalMode=week");
    expect(state.path).toBe("~cron");
    expect(state.cronView).toBe("calendar");
    expect(state.cronCalMode).toBe("week");
  });

  it("round-trips cronView through serialize/parse", () => {
    const qs = serializeUrlState({ path: "~cron", cronView: "insights" });
    const parsed = parseUrlState(qs);
    expect(parsed.cronView).toBe("insights");
  });

  it("omits cronView=overview from URL (default)", () => {
    const qs = serializeUrlState({ path: "~cron", cronView: "overview" });
    expect(qs).not.toContain("cronView");
  });

  it("round-trips cronCalMode through serialize/parse", () => {
    const qs = serializeUrlState({ path: "~cron", cronView: "calendar", cronCalMode: "week" });
    const parsed = parseUrlState(qs);
    expect(parsed.cronCalMode).toBe("week");
  });

  it("round-trips cronDate through serialize/parse", () => {
    const qs = serializeUrlState({ path: "~cron", cronView: "calendar", cronDate: "2026-03-05" });
    const parsed = parseUrlState(qs);
    expect(parsed.cronDate).toBe("2026-03-05");
  });

  it("round-trips cronRunFilter through serialize/parse", () => {
    const qs = serializeUrlState({ path: "~cron/job-1", cronRunFilter: "error" });
    const parsed = parseUrlState(qs);
    expect(parsed.cronRunFilter).toBe("error");
  });

  it("omits cronRunFilter=all from URL (default)", () => {
    const qs = serializeUrlState({ path: "~cron/job-1", cronRunFilter: "all" });
    expect(qs).not.toContain("cronRunFilter");
  });

  it("round-trips cronRun timestamp through serialize/parse", () => {
    const ts = 1772749020657;
    const qs = serializeUrlState({ path: "~cron/job-1", cronRun: ts });
    const parsed = parseUrlState(qs);
    expect(parsed.cronRun).toBe(ts);
  });

  it("rejects invalid cronView values", () => {
    const state = parseUrlState("cronView=bogus");
    expect(state.cronView).toBeNull();
  });

  it("rejects invalid cronCalMode values", () => {
    const state = parseUrlState("cronCalMode=bogus");
    expect(state.cronCalMode).toBeNull();
  });

  it("rejects invalid cronRunFilter values", () => {
    const state = parseUrlState("cronRunFilter=bogus");
    expect(state.cronRunFilter).toBeNull();
  });

  it("builds full cron calendar URL", () => {
    const url = buildUrl({ path: "~cron", cronView: "calendar", cronCalMode: "week", cronDate: "2026-03-05" });
    const parsed = parseUrlState(url.replace("/?", ""));
    expect(parsed.path).toBe("~cron");
    expect(parsed.cronView).toBe("calendar");
    expect(parsed.cronCalMode).toBe("week");
    expect(parsed.cronDate).toBe("2026-03-05");
  });

  it("builds full cron job detail URL with run filter", () => {
    const url = buildUrl({ path: "~cron/abc123", cronRunFilter: "error", cronRun: 12345 });
    const parsed = parseUrlState(url.replace("/?", ""));
    expect(parsed.path).toBe("~cron/abc123");
    expect(parsed.cronRunFilter).toBe("error");
    expect(parsed.cronRun).toBe(12345);
  });
});
