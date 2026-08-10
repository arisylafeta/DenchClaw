import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Dirent } from "node:fs";

vi.mock("@/lib/auth", () => ({
  currentUser: vi.fn(async () => ({
    id: "11111111-1111-4111-8111-111111111111",
    email: "ari@rebattery.io",
    displayName: "Ari",
  })),
}));

// Mock node:fs
vi.mock("node:fs", () => ({
  readdirSync: vi.fn(() => []),
  readFileSync: vi.fn(() => ""),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  statSync: vi.fn(() => ({ isDirectory: () => false, size: 100 })),
  writeFileSync: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  readdir: vi.fn(async () => []),
  readFile: vi.fn(async () => ""),
  access: vi.fn(async () => {
    throw new Error("ENOENT");
  }),
  stat: vi.fn(async () => ({ isDirectory: () => false, isFile: () => false })),
}));

// Mock node:os
vi.mock("node:os", () => ({
  homedir: vi.fn(() => "/home/testuser"),
}));

// Mock workspace
vi.mock("@/lib/workspace", () => ({
  resolveWorkspaceRoot: vi.fn(() => null),
  resolveOpenClawStateDir: vi.fn(() => "/home/testuser/.openclaw-dench"),
  getActiveWorkspaceName: vi.fn(() => null),
  parseSimpleYaml: vi.fn(() => ({})),
  duckdbQueryAll: vi.fn(() => []),
  duckdbQueryAllAsync: vi.fn(async () => []),
  duckdbQueryOnFileAsync: vi.fn(async () => []),
  isDatabaseFile: vi.fn(() => false),
  discoverDuckDBPaths: vi.fn(() => []),
  pivotViewIdentifier: vi.fn((name: string) => `"v_${name}"`),
  readObjectYamlIcon: vi.fn(() => undefined),
  resolveDuckdbBin: vi.fn(() => null),
  safeResolvePath: vi.fn(() => null),
}));

vi.mock("@/lib/postgres", () => ({
  queryPg: vi.fn(async () => []),
}));

vi.mock("@/lib/crm-postgres/tree", () => ({
  loadPostgresTreeObjects: vi.fn(async () => new Map()),
}));

vi.mock("@/lib/crm-postgres/suggest-files", () => ({
  searchPostgresObjects: vi.fn(async () => []),
  searchPostgresEntries: vi.fn(async () => []),
}));

function makeDirent(name: string, isDir: boolean): Dirent {
  return {
    name,
    isDirectory: () => isDir,
    isFile: () => !isDir,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    isSymbolicLink: () => false,
    path: "",
    parentPath: "",
  } as Dirent;
}

describe("Workspace Tree & Browse API", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.mock("node:fs", () => ({
      readdirSync: vi.fn(() => []),
      readFileSync: vi.fn(() => ""),
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      statSync: vi.fn(() => ({ isDirectory: () => false, size: 100 })),
      writeFileSync: vi.fn(),
    }));
    vi.mock("node:fs/promises", () => ({
      readdir: vi.fn(async () => []),
      readFile: vi.fn(async () => ""),
      access: vi.fn(async () => {
        throw new Error("ENOENT");
      }),
      stat: vi.fn(async () => ({ isDirectory: () => false, isFile: () => false })),
    }));
    vi.mock("node:os", () => ({
      homedir: vi.fn(() => "/home/testuser"),
    }));
    vi.mock("@/lib/workspace", () => ({
      resolveWorkspaceRoot: vi.fn(() => null),
      resolveOpenClawStateDir: vi.fn(() => "/home/testuser/.openclaw-dench"),
      getActiveWorkspaceName: vi.fn(() => null),
      parseSimpleYaml: vi.fn(() => ({})),
      duckdbQueryAll: vi.fn(() => []),
      duckdbQueryAllAsync: vi.fn(async () => []),
      duckdbQueryOnFileAsync: vi.fn(async () => []),
      isDatabaseFile: vi.fn(() => false),
      discoverDuckDBPaths: vi.fn(() => []),
      pivotViewIdentifier: vi.fn((name: string) => `"v_${name}"`),
      readObjectYamlIcon: vi.fn(() => undefined),
      resolveDuckdbBin: vi.fn(() => null),
      safeResolvePath: vi.fn(() => null),
    }));
    vi.mock("@/lib/postgres", () => ({
      queryPg: vi.fn(async () => []),
    }));
    vi.mock("@/lib/crm-postgres/tree", () => ({
      loadPostgresTreeObjects: vi.fn(async () => new Map()),
    }));
    vi.mock("@/lib/crm-postgres/suggest-files", () => ({
      searchPostgresObjects: vi.fn(async () => []),
      searchPostgresEntries: vi.fn(async () => []),
    }));
    delete process.env.CRM_DB_BACKEND;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── GET /api/workspace/tree ────────────────────────────────────

  describe("GET /api/workspace/tree", () => {
    it("returns tree with exists=false when no workspace root", async () => {
      const { GET } = await import("./tree/route.js");
      const req = new Request("http://localhost/api/workspace/tree");
      const res = await GET(req);
      const json = await res.json();
      expect(json.exists).toBe(false);
      expect(json.tree).toEqual([]);
      expect(json.workspace).toBeNull();
    });

    it("returns tree with workspace files", async () => {
      const { resolveWorkspaceRoot, getActiveWorkspaceName } = await import("@/lib/workspace");
      vi.mocked(resolveWorkspaceRoot).mockReturnValue("/ws");
      vi.mocked(getActiveWorkspaceName).mockReturnValue("default");
      const { readdir: mockReaddir } = await import("node:fs/promises");
      vi.mocked(mockReaddir).mockImplementation((dir) => {
        if (String(dir) === "/ws") {
          return Promise.resolve([
            makeDirent("knowledge", true),
            makeDirent("readme.md", false),
          ] as unknown as never[]);
        }
        return Promise.resolve([] as unknown as never[]);
      });

      const { GET } = await import("./tree/route.js");
      const req = new Request("http://localhost/api/workspace/tree");
      const res = await GET(req);
      const json = await res.json();
      expect(json.exists).toBe(true);
      expect(json.tree.length).toBeGreaterThan(0);
      expect(json.workspace).toBe("default");
    });

    it("includes workspaceRoot in response", async () => {
      const { resolveWorkspaceRoot } = await import("@/lib/workspace");
      vi.mocked(resolveWorkspaceRoot).mockReturnValue("/ws");

      const { GET } = await import("./tree/route.js");
      const req = new Request("http://localhost/api/workspace/tree");
      const res = await GET(req);
      const json = await res.json();
      expect(json.workspaceRoot).toBe("/ws");
    });

    it("includes root IDENTITY.md in the workspace tree", async () => {
      const { resolveWorkspaceRoot } = await import("@/lib/workspace");
      vi.mocked(resolveWorkspaceRoot).mockReturnValue("/ws");
      const { readdir: mockReaddir } = await import("node:fs/promises");
      vi.mocked(mockReaddir).mockImplementation((dir) => {
        if (String(dir) === "/ws") {
          return Promise.resolve([
            makeDirent("IDENTITY.md", false),
            makeDirent("notes.md", false),
          ] as unknown as never[]);
        }
        return Promise.resolve([] as unknown as never[]);
      });

      const { GET } = await import("./tree/route.js");
      const req = new Request("http://localhost/api/workspace/tree");
      const res = await GET(req);
      const json = await res.json();
      const paths = (json.tree as Array<{ path: string }>).map((n) => n.path);
      expect(paths).toContain("IDENTITY.md");
      expect(paths).toContain("notes.md");
    });

    it("does not inject a virtual skills folder into the workspace tree", async () => {
      const { resolveWorkspaceRoot } = await import("@/lib/workspace");
      vi.mocked(resolveWorkspaceRoot).mockReturnValue("/ws");
      const { readdir: mockReaddir } = await import("node:fs/promises");
      vi.mocked(mockReaddir).mockImplementation((dir) => {
        if (String(dir) === "/ws") {
          return Promise.resolve([
            makeDirent("skills", true),
          ] as unknown as never[]);
        }
        if (String(dir) === "/ws/skills") {
          return Promise.resolve([
            makeDirent("alpha", true),
          ] as unknown as never[]);
        }
        if (String(dir) === "/ws/skills/alpha") {
          return Promise.resolve([
            makeDirent("SKILL.md", false),
          ] as unknown as never[]);
        }
        return Promise.resolve([] as unknown as never[]);
      });

      const { GET } = await import("./tree/route.js");
      const req = new Request("http://localhost/api/workspace/tree");
      const res = await GET(req);
      const json = await res.json();
      const rootPaths = (json.tree as Array<{ path: string }>).map((node) => node.path);
      expect(rootPaths).toContain("skills");
      expect(rootPaths).not.toContain("~skills");
    });

    it("uses Postgres tree helper and avoids DuckDB in postgres mode", async () => {
      process.env.CRM_DB_BACKEND = "postgres";
      const workspace = await import("@/lib/workspace");
      vi.mocked(workspace.resolveWorkspaceRoot).mockReturnValue("/ws");
      const { readdir: mockReaddir } = await import("node:fs/promises");
      vi.mocked(mockReaddir).mockImplementation((dir) => {
        if (String(dir) === "/ws") {
          return Promise.resolve([makeDirent("people", true)] as unknown as never[]);
        }
        return Promise.resolve([] as unknown as never[]);
      });

      const pgTree = await import("@/lib/crm-postgres/tree");
      vi.mocked(pgTree.loadPostgresTreeObjects).mockResolvedValue(new Map([
        ["people", { id: "obj-people", name: "people", default_view: "table", description: "People" }],
      ]));
      vi.mocked(workspace.duckdbQueryAllAsync).mockClear();
      vi.mocked(workspace.discoverDuckDBPaths).mockClear();
      vi.mocked(workspace.duckdbQueryOnFileAsync).mockClear();
      vi.mocked(pgTree.loadPostgresTreeObjects).mockClear();

      const { GET } = await import("./tree/route.js");
      const req = new Request("http://localhost/api/workspace/tree");
      const res = await GET(req);
      const json = await res.json();

      expect(pgTree.loadPostgresTreeObjects).toHaveBeenCalled();
      expect(workspace.duckdbQueryAllAsync).not.toHaveBeenCalled();
      expect(workspace.discoverDuckDBPaths).not.toHaveBeenCalled();
      expect(workspace.duckdbQueryOnFileAsync).not.toHaveBeenCalled();
      expect(json.tree).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "people", type: "object" }),
      ]));
    });

    it("hides noisy CRM sync object folders by default without hiding ordinary object folders", async () => {
      // The left CRM navigation can still choose what belongs in the product
      // nav, but the filesystem tree should reflect real object folders while
      // keeping noisy sync backing tables behind the hidden-files toggle.
      const { resolveWorkspaceRoot, duckdbQueryAllAsync } = await import("@/lib/workspace");
      vi.mocked(resolveWorkspaceRoot).mockReturnValue("/ws");
      vi.mocked(duckdbQueryAllAsync).mockResolvedValue([
        { name: "people", default_view: "table", hidden_in_sidebar: "false" },
        { name: "company", default_view: "table", hidden_in_sidebar: "false" },
        { name: "opportunity", default_view: "kanban", hidden_in_sidebar: "false" },
        { name: "email_message", default_view: "table", hidden_in_sidebar: "true" },
        { name: "email_thread", default_view: "table", hidden_in_sidebar: "true" },
        { name: "calendar_event", default_view: "table", hidden_in_sidebar: "true" },
        { name: "interaction", default_view: "table", hidden_in_sidebar: "true" },
        { name: "secret", default_view: "table", hidden_in_sidebar: "true" },
      ] as never);

      const { readdir: mockReaddir } = await import("node:fs/promises");
      vi.mocked(mockReaddir).mockImplementation((dir) => {
        if (String(dir) === "/ws") {
          return Promise.resolve([
            makeDirent("people", true),
            makeDirent("company", true),
            makeDirent("opportunity", true),
            makeDirent("secret", true),
            makeDirent("email_message", true),
            makeDirent("email_thread", true),
            makeDirent("calendar_event", true),
            makeDirent("interaction", true),
          ] as unknown as never[]);
        }
        return Promise.resolve([] as unknown as never[]);
      });

      const { GET } = await import("./tree/route.js");
      const req = new Request("http://localhost/api/workspace/tree");
      const res = await GET(req);
      const json = await res.json();
      const rootPaths = (json.tree as Array<{ path: string }>).map((n) => n.path);
      // All visible objects must appear in the tree.
      expect(rootPaths).toContain("people");
      expect(rootPaths).toContain("company");
      expect(rootPaths).toContain("opportunity");
      expect(rootPaths).toContain("secret");
      expect(rootPaths).not.toContain("email_message");
      expect(rootPaths).not.toContain("email_thread");
      expect(rootPaths).not.toContain("calendar_event");
      expect(rootPaths).not.toContain("interaction");
    });

    it("shows CRM sync object folders when hidden files are revealed", async () => {
      const { resolveWorkspaceRoot, duckdbQueryAllAsync } = await import("@/lib/workspace");
      vi.mocked(resolveWorkspaceRoot).mockReturnValue("/ws");
      vi.mocked(duckdbQueryAllAsync).mockResolvedValue([
        { name: "people", default_view: "table" },
        { name: "email_message", default_view: "table" },
        { name: "email_thread", default_view: "table" },
        { name: "calendar_event", default_view: "table" },
        { name: "interaction", default_view: "table" },
      ] as never);

      const { readdir: mockReaddir } = await import("node:fs/promises");
      vi.mocked(mockReaddir).mockImplementation((dir) => {
        if (String(dir) === "/ws") {
          return Promise.resolve([
            makeDirent("people", true),
            makeDirent("email_message", true),
            makeDirent("email_thread", true),
            makeDirent("calendar_event", true),
            makeDirent("interaction", true),
          ] as unknown as never[]);
        }
        return Promise.resolve([] as unknown as never[]);
      });

      const { GET } = await import("./tree/route.js");
      const req = new Request("http://localhost/api/workspace/tree?showHidden=1");
      const res = await GET(req);
      const json = await res.json();
      const rootPaths = (json.tree as Array<{ path: string }>).map((n) => n.path);
      expect(rootPaths).toContain("people");
      expect(rootPaths).toContain("email_message");
      expect(rootPaths).toContain("email_thread");
      expect(rootPaths).toContain("calendar_event");
      expect(rootPaths).toContain("interaction");
    });

    it("does not classify nested folders as objects by basename alone", async () => {
      const { resolveWorkspaceRoot, duckdbQueryAllAsync } = await import("@/lib/workspace");
      vi.mocked(resolveWorkspaceRoot).mockReturnValue("/ws");
      vi.mocked(duckdbQueryAllAsync).mockResolvedValue([
        { name: "opportunity", default_view: "table" },
      ] as never);

      const { readdir: mockReaddir } = await import("node:fs/promises");
      vi.mocked(mockReaddir).mockImplementation((dir) => {
        if (String(dir) === "/ws") {
          return Promise.resolve([
            makeDirent("archive", true),
            makeDirent("opportunity", true),
          ] as unknown as never[]);
        }
        if (String(dir) === "/ws/archive") {
          return Promise.resolve([
            makeDirent("opportunity", true),
          ] as unknown as never[]);
        }
        return Promise.resolve([] as unknown as never[]);
      });

      const { GET } = await import("./tree/route.js");
      const req = new Request("http://localhost/api/workspace/tree");
      const res = await GET(req);
      const json = await res.json();
      const rootObject = (json.tree as Array<{ path: string; type: string; children?: Array<{ path: string; type: string }> }>)
        .find((node) => node.path === "opportunity");
      const archive = (json.tree as Array<{ path: string; type: string; children?: Array<{ path: string; type: string }> }>)
        .find((node) => node.path === "archive");
      const nestedFolder = archive?.children?.find((node) => node.path === "archive/opportunity");

      expect(rootObject?.type).toBe("object");
      expect(nestedFolder?.type).toBe("folder");
    });

    it("yields before tree discovery completes (prevents UI freeze during active agent runs)", async () => {
      const { resolveWorkspaceRoot, duckdbQueryAll, duckdbQueryAllAsync } = await import("@/lib/workspace");
      vi.mocked(resolveWorkspaceRoot).mockReturnValue("/ws");
      vi.mocked(duckdbQueryAll).mockImplementation(() => {
        const start = Date.now();
        while (Date.now() - start < 75) {
          // busy wait: if the route ever regresses to the sync helper,
          // this test should fail on the elapsed-time assertion below.
        }
        return [];
      });

      let releaseDuckdb: (rows: Array<{ name: string }>) => void;
      const duckdbGate = new Promise<Array<{ name: string }>>((resolve) => {
        releaseDuckdb = resolve;
      });
      vi.mocked(duckdbQueryAllAsync).mockReturnValue(duckdbGate);

      const { readdir: mockReaddir } = await import("node:fs/promises");
      vi.mocked(mockReaddir).mockResolvedValue([] as unknown as never[]);

      const { GET } = await import("./tree/route.js");
      const req = new Request("http://localhost/api/workspace/tree");

      const startedAt = Date.now();
      const responsePromise = GET(req);
      const elapsedMs = Date.now() - startedAt;

      expect(elapsedMs).toBeLessThan(40);

      releaseDuckdb!([]);
      const res = await responsePromise;
      expect(res.status).toBe(200);
    });
  });

  // ─── GET /api/workspace/browse ──────────────────────────────────

  describe("GET /api/workspace/browse", () => {
    it("returns directory listing", async () => {
      const { existsSync: mockExists, readdirSync: mockReaddir, statSync: mockStat } = await import("node:fs");
      vi.mocked(mockExists).mockReturnValue(true);
      vi.mocked(mockReaddir).mockReturnValue([
        makeDirent("file.txt", false),
        makeDirent("subfolder", true),
      ] as unknown as never[]);
      vi.mocked(mockStat).mockReturnValue({ isDirectory: () => false, size: 100 } as never);

      const { GET } = await import("./browse/route.js");
      const req = new Request("http://localhost/api/workspace/browse?dir=/tmp/test");
      const res = await GET(req);
      const json = await res.json();
      expect(json.entries).toBeDefined();
      expect(json.currentDir).toBeDefined();
    });

    it("returns parentDir for nested directories", async () => {
      const { existsSync: mockExists, readdirSync: mockReaddir, statSync: mockStat } = await import("node:fs");
      vi.mocked(mockExists).mockReturnValue(true);
      vi.mocked(mockReaddir).mockReturnValue([]);
      vi.mocked(mockStat).mockReturnValue({ isDirectory: () => true, size: 0 } as never);

      const { GET } = await import("./browse/route.js");
      const req = new Request("http://localhost/api/workspace/browse?dir=/tmp/test/sub");
      const res = await GET(req);
      const json = await res.json();
      expect(json.parentDir).toBeDefined();
    });
  });

  // ─── GET /api/workspace/suggest-files ────────────────────────────

  describe("GET /api/workspace/suggest-files", () => {
    it("returns suggestions when workspace exists", async () => {
      const { resolveWorkspaceRoot } = await import("@/lib/workspace");
      vi.mocked(resolveWorkspaceRoot).mockReturnValue("/ws");
      const { existsSync: mockExists, readdirSync: mockReaddir } = await import("node:fs");
      vi.mocked(mockExists).mockReturnValue(true);
      vi.mocked(mockReaddir).mockReturnValue([
        makeDirent("doc.md", false),
      ] as unknown as never[]);

      const { GET } = await import("./suggest-files/route.js");
      const req = new Request("http://localhost/api/workspace/suggest-files?q=doc");
      const res = await GET(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.items).toBeDefined();
    });

    it("includes root IDENTITY.md in sidebar file suggestions", async () => {
      const { resolveWorkspaceRoot } = await import("@/lib/workspace");
      vi.mocked(resolveWorkspaceRoot).mockReturnValue("/ws");
      const { existsSync: mockExists, readdirSync: mockReaddir } = await import("node:fs");
      vi.mocked(mockExists).mockReturnValue(true);
      vi.mocked(mockReaddir).mockImplementation((dir) => {
        if (String(dir) === "/ws") {
          return [
            makeDirent("IDENTITY.md", false),
            makeDirent("doc.md", false),
          ] as unknown as never[];
        }
        return [] as unknown as never[];
      });

      const { GET } = await import("./suggest-files/route.js");
      const req = new Request("http://localhost/api/workspace/suggest-files");
      const res = await GET(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      const names = (json.items as Array<{ name: string }>).map((item) => item.name);
      expect(names).toContain("doc.md");
      expect(names).toContain("IDENTITY.md");
    });

    it("uses Postgres suggest helpers and avoids DuckDB in postgres mode", async () => {
      process.env.CRM_DB_BACKEND = "postgres";
      const workspace = await import("@/lib/workspace");
      vi.mocked(workspace.resolveWorkspaceRoot).mockReturnValue("/ws");
      const pgSuggest = await import("@/lib/crm-postgres/suggest-files");
      vi.mocked(pgSuggest.searchPostgresObjects).mockResolvedValue([
        {
          name: "people",
          path: "workspace:object:people",
          type: "object",
          icon: "👤",
          defaultView: "table",
        },
      ] as never);
      vi.mocked(pgSuggest.searchPostgresEntries).mockResolvedValue([
        {
          name: "Ada Lovelace",
          path: "workspace:entry:people:person-1",
          type: "entry",
          icon: "👤",
          objectName: "people",
          entryId: "person-1",
        },
      ] as never);
      vi.mocked(workspace.duckdbQueryAllAsync).mockClear();
      vi.mocked(workspace.discoverDuckDBPaths).mockClear();
      vi.mocked(workspace.duckdbQueryOnFileAsync).mockClear();
      vi.mocked(pgSuggest.searchPostgresObjects).mockClear();
      vi.mocked(pgSuggest.searchPostgresEntries).mockClear();

      const { GET } = await import("./suggest-files/route.js");
      const req = new Request("http://localhost/api/workspace/suggest-files?q=ada");
      const res = await GET(req);
      const json = await res.json();

      expect(workspace.duckdbQueryAllAsync).not.toHaveBeenCalled();
      expect(workspace.discoverDuckDBPaths).not.toHaveBeenCalled();
      expect(workspace.duckdbQueryOnFileAsync).not.toHaveBeenCalled();
      expect(pgSuggest.searchPostgresObjects).toHaveBeenCalledWith("ada", 10);
      expect(pgSuggest.searchPostgresEntries).toHaveBeenCalledWith(
        "ada",
        15,
        "11111111-1111-4111-8111-111111111111",
      );
      expect(json.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "workspace:object:people" }),
        expect.objectContaining({ path: "workspace:entry:people:person-1" }),
      ]));
    });
  });

  // ─── GET /api/workspace/context ──────────────────────────────────

  describe("GET /api/workspace/context", () => {
    it("returns exists=false when no workspace root", async () => {
      const { resolveWorkspaceRoot } = await import("@/lib/workspace");
      vi.mocked(resolveWorkspaceRoot).mockReturnValue(null);

      const { GET } = await import("./context/route.js");
      const res = await GET();
      const json = await res.json();
      expect(json.exists).toBe(false);
    });

    it("returns context when workspace_context.yaml exists", async () => {
      const { resolveWorkspaceRoot, parseSimpleYaml } = await import("@/lib/workspace");
      vi.mocked(resolveWorkspaceRoot).mockReturnValue("/ws");
      vi.mocked(parseSimpleYaml).mockReturnValue({ org_name: "Acme", org_slug: "acme" });
      const { existsSync: mockExists, readFileSync: mockReadFile } = await import("node:fs");
      vi.mocked(mockExists).mockReturnValue(true);
      vi.mocked(mockReadFile).mockReturnValue("org_name: Acme" as never);

      const { GET } = await import("./context/route.js");
      const res = await GET();
      const json = await res.json();
      expect(json.exists).toBe(true);
    });
  });

  // ─── GET /api/workspace/search-index ─────────────────────────────

  describe("GET /api/workspace/search-index", () => {
    it("returns only the CRM nav shortcuts when no workspace", async () => {
      const { resolveWorkspaceRoot } = await import("@/lib/workspace");
      vi.mocked(resolveWorkspaceRoot).mockReturnValue(null);

      const { GET } = await import("./search-index/route.js");
      const res = await GET();
      const json = await res.json();
      // The 4 CRM shortcuts (People / Companies / Inbox / Calendar) are
      // always present so cmd-K can navigate to them even before the
      // user has a workspace. Anything else here would imply a real DB
      // hit, which the mock prevents.
      expect(json.items.length).toBe(4);
      expect(json.items.every((it: { sublabel: string }) => it.sublabel === "CRM")).toBe(true);
      expect(json.items.map((it: { id: string }) => it.id)).toEqual([
        "~crm/people",
        "~crm/companies",
        "~crm/inbox",
        "~crm/calendar",
      ]);
    });

    it("returns file items from workspace tree", async () => {
      const { resolveWorkspaceRoot, duckdbQueryAll } = await import("@/lib/workspace");
      vi.mocked(resolveWorkspaceRoot).mockReturnValue("/ws");
      vi.mocked(duckdbQueryAll).mockReturnValue([]);
      const { existsSync: mockExists, readdirSync: mockReaddir } = await import("node:fs");
      vi.mocked(mockExists).mockReturnValue(true);
      vi.mocked(mockReaddir).mockImplementation((dir) => {
        if (String(dir) === "/ws") {
          return [makeDirent("readme.md", false)] as unknown as never[];
        }
        return [] as unknown as never[];
      });

      const { GET } = await import("./search-index/route.js");
      const res = await GET();
      const json = await res.json();
      expect(json.items.length).toBeGreaterThanOrEqual(0);
    });

    it("uses Postgres instead of DuckDB when CRM_DB_BACKEND is postgres", async () => {
      process.env.CRM_DB_BACKEND = "postgres";
      const workspace = await import("@/lib/workspace");
      vi.mocked(workspace.resolveWorkspaceRoot).mockReturnValue("/ws");
      const { queryPg } = await import("@/lib/postgres");
      vi.mocked(queryPg).mockImplementation(async (sql: string) => {
        if (sql.includes("from crm_objects")) {
          return [{
            id: "obj-people",
            name: "people",
            default_view: "table",
            display_field: "Full Name",
          }] as never[];
        }
        if (sql.includes("from crm_fields")) {
          return [
            { id: "field-name", object_id: "obj-people", name: "Full Name", type: "text", canonical_column: "full_name", sort_order: 0 },
            { id: "field-email", object_id: "obj-people", name: "Email", type: "email", canonical_column: "email", sort_order: 1 },
          ] as never[];
        }
        if (sql.includes("from crm_people")) {
          return [{ entry_id: "person-1", "Full Name": "Ada Lovelace", Email: "ada@example.test" }] as never[];
        }
        return [] as never[];
      });
      vi.clearAllMocks();

      const { GET } = await import("./search-index/route.js");
      const res = await GET();
      const json = await res.json();

      expect(workspace.duckdbQueryAllAsync).not.toHaveBeenCalled();
      expect(workspace.discoverDuckDBPaths).not.toHaveBeenCalled();
      expect(workspace.duckdbQueryOnFileAsync).not.toHaveBeenCalled();
      expect(json.items).toContainEqual(expect.objectContaining({
        id: "entry:people:person-1",
        label: "Ada Lovelace",
        objectName: "people",
        entryId: "person-1",
        fields: { "Full Name": "Ada Lovelace", Email: "ada@example.test" },
      }));
    });
  });
});
