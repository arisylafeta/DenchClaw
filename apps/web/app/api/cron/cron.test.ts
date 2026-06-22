import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock node:fs
vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ""),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  statSync: vi.fn(() => ({ mtimeMs: Date.now() })),
}));

// Mock node:os
vi.mock("node:os", () => ({
  homedir: vi.fn(() => "/home/testuser"),
}));

describe("Cron API routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.mock("node:fs", () => ({
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(() => ""),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ mtimeMs: Date.now() })),
    }));
    vi.mock("node:os", () => ({
      homedir: vi.fn(() => "/home/testuser"),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── GET /api/cron/jobs ─────────────────────────────────────────

  describe("GET /api/cron/jobs", () => {
    it("returns empty jobs when no config file", async () => {
      const { GET } = await import("./jobs/route.js");
      const res = await GET();
      const json = await res.json();
      expect(json.jobs).toEqual([]);
    });

    it("returns jobs from config file", async () => {
      const { existsSync: mockExists, readFileSync: mockReadFile } = await import("node:fs");
      vi.mocked(mockExists).mockReturnValue(true);
      const cronStore = {
        version: 1,
        jobs: [
          { id: "j1", name: "Daily sync", schedule: "0 8 * * *", enabled: true, command: "sync" },
        ],
      };
      vi.mocked(mockReadFile).mockReturnValue(JSON.stringify(cronStore) as never);

      const { GET } = await import("./jobs/route.js");
      const res = await GET();
      const json = await res.json();
      expect(json.jobs).toHaveLength(1);
      expect(json.jobs[0].name).toBe("Daily sync");
    });

    it("handles corrupt jobs file gracefully", async () => {
      const { existsSync: mockExists, readFileSync: mockReadFile } = await import("node:fs");
      vi.mocked(mockExists).mockReturnValue(true);
      vi.mocked(mockReadFile).mockReturnValue("not json" as never);

      const { GET } = await import("./jobs/route.js");
      const res = await GET();
      const json = await res.json();
      expect(json.jobs).toEqual([]);
    });

    it("reads Hermes global jobs when running with Hermes backend", async () => {
      process.env.DENCH_AGENT_BACKEND = "hermes";
      process.env.DENCH_HOME = "/root/.hermes";

      const { existsSync: mockExists, readFileSync: mockReadFile } = await import("node:fs");
      vi.mocked(mockExists).mockImplementation((p) => {
        const s = String(p);
        return s === "/root/.hermes/cron/jobs.json";
      });
      vi.mocked(mockReadFile).mockImplementation((p) => {
        if (String(p) === "/root/.hermes/cron/jobs.json") {
          return JSON.stringify({
            jobs: [
              {
                id: "j-hermes",
                name: "Hermes job",
                enabled: true,
                next_run_at: "2026-06-23T08:00:00+00:00",
              },
            ],
          }) as never;
        }
        return "" as never;
      });

      const { GET } = await import("./jobs/route.js");
      const res = await GET();
      const json = await res.json();

      expect(json.jobs).toHaveLength(1);
      expect(json.jobs[0].id).toBe("j-hermes");
      expect(json.cronStatus.enabled).toBe(true);
    });

    it("returns the heartbeat interval from agents.defaults.heartbeat.every", async () => {
      const { existsSync: mockExists, readFileSync: mockReadFile } = await import("node:fs");
      vi.mocked(mockExists).mockImplementation((p) => String(p).endsWith("openclaw.json"));
      vi.mocked(mockReadFile).mockImplementation((p) => {
        if (String(p).endsWith("openclaw.json")) {
          return JSON.stringify({
            agents: { defaults: { heartbeat: { every: "24h" } } },
          }) as never;
        }
        return "" as never;
      });

      const { GET } = await import("./jobs/route.js");
      const res = await GET();
      const json = await res.json();
      expect(json.heartbeat.intervalMs).toBe(24 * 60 * 60_000);
    });

    it("falls back to 24h when heartbeat.every is missing", async () => {
      const { existsSync: mockExists, readFileSync: mockReadFile } = await import("node:fs");
      vi.mocked(mockExists).mockImplementation((p) => String(p).endsWith("openclaw.json"));
      vi.mocked(mockReadFile).mockImplementation((p) => {
        if (String(p).endsWith("openclaw.json")) {
          return JSON.stringify({ agents: { defaults: {} } }) as never;
        }
        return "" as never;
      });

      const { GET } = await import("./jobs/route.js");
      const res = await GET();
      const json = await res.json();
      expect(json.heartbeat.intervalMs).toBe(24 * 60 * 60_000);
    });

    it("falls back to 24h when openclaw.json is missing entirely", async () => {
      const { existsSync: mockExists } = await import("node:fs");
      vi.mocked(mockExists).mockReturnValue(false);

      const { GET } = await import("./jobs/route.js");
      const res = await GET();
      const json = await res.json();
      expect(json.heartbeat.intervalMs).toBe(24 * 60 * 60_000);
    });
  });

  // ─── parseDurationToMs ───────────────────────────────────────────

  describe("parseDurationToMs", () => {
    it("parses single-unit durations", async () => {
      const { parseDurationToMs } = await import("@/lib/duration");
      expect(parseDurationToMs("24h")).toBe(24 * 60 * 60_000);
      expect(parseDurationToMs("30m")).toBe(30 * 60_000);
      expect(parseDurationToMs("45s")).toBe(45_000);
      expect(parseDurationToMs("2d")).toBe(2 * 24 * 60 * 60_000);
    });

    it("sums compound durations like 1h30m", async () => {
      const { parseDurationToMs } = await import("@/lib/duration");
      expect(parseDurationToMs("1h30m")).toBe(60 * 60_000 + 30 * 60_000);
      expect(parseDurationToMs("1d12h")).toBe(36 * 60 * 60_000);
    });

    it("is case-insensitive on units", async () => {
      const { parseDurationToMs } = await import("@/lib/duration");
      expect(parseDurationToMs("24H")).toBe(24 * 60 * 60_000);
    });

    it("returns null for unparseable input", async () => {
      const { parseDurationToMs } = await import("@/lib/duration");
      expect(parseDurationToMs("")).toBeNull();
      expect(parseDurationToMs("forever")).toBeNull();
      expect(parseDurationToMs("24h junk")).toBeNull();
    });
  });

  // ─── GET /api/cron/jobs/[jobId]/runs ────────────────────────────

  describe("GET /api/cron/jobs/[jobId]/runs", () => {
    it("returns empty entries when no runs file", async () => {
      const { GET } = await import("./jobs/[jobId]/runs/route.js");
      const res = await GET(
        new Request("http://localhost/api/cron/jobs/j1/runs"),
        { params: Promise.resolve({ jobId: "j1" }) },
      );
      const json = await res.json();
      expect(json.entries).toEqual([]);
    });

    it("returns run entries from jsonl file", async () => {
      const { existsSync: mockExists, readFileSync: mockReadFile } = await import("node:fs");
      vi.mocked(mockExists).mockReturnValue(true);
      const lines = [
        JSON.stringify({ ts: 1000, jobId: "j1", action: "finished", status: "completed", summary: "Done" }),
        JSON.stringify({ ts: 2000, jobId: "j1", action: "finished", status: "completed", summary: "In progress" }),
      ].join("\n");
      vi.mocked(mockReadFile).mockReturnValue(lines as never);

      const { GET } = await import("./jobs/[jobId]/runs/route.js");
      const res = await GET(
        new Request("http://localhost/api/cron/jobs/j1/runs"),
        { params: Promise.resolve({ jobId: "j1" }) },
      );
      const json = await res.json();
      expect(json.entries.length).toBeGreaterThan(0);
    });

    it("respects limit query param", async () => {
      const { existsSync: mockExists, readFileSync: mockReadFile } = await import("node:fs");
      vi.mocked(mockExists).mockReturnValue(true);
      const lines = Array.from({ length: 50 }, (_, i) =>
        JSON.stringify({ ts: i, status: "completed" }),
      ).join("\n");
      vi.mocked(mockReadFile).mockReturnValue(lines as never);

      const { GET } = await import("./jobs/[jobId]/runs/route.js");
      const res = await GET(
        new Request("http://localhost/api/cron/jobs/j1/runs?limit=5"),
        { params: Promise.resolve({ jobId: "j1" }) },
      );
      const json = await res.json();
      expect(json.entries.length).toBeLessThanOrEqual(5);
    });
  });

  // ─── GET /api/cron/runs/[sessionId] ─────────────────────────────

  describe("GET /api/cron/runs/[sessionId]", () => {
    it("returns 404 when session not found", async () => {
      const { GET } = await import("./runs/[sessionId]/route.js");
      const res = await GET(
        new Request("http://localhost"),
        { params: Promise.resolve({ sessionId: "nonexistent" }) },
      );
      expect(res.status).toBe(404);
    });
  });

  // ─── GET /api/cron/runs/search-transcript ───────────────────────

  describe("GET /api/cron/runs/search-transcript", () => {
    it("returns 400 when missing required params", async () => {
      const { GET } = await import("./runs/search-transcript/route.js");
      const req = new Request("http://localhost/api/cron/runs/search-transcript");
      const res = await GET(req);
      expect(res.status).toBe(400);
    });

    it("returns 404 when no transcript found", async () => {
      const { GET } = await import("./runs/search-transcript/route.js");
      const req = new Request("http://localhost/api/cron/runs/search-transcript?jobId=j1&runAtMs=1000");
      const res = await GET(req);
      expect(res.status).toBe(404);
    });
  });

  // ─── GET /api/cron/jobs heartbeat from config ──────────────────

  describe("GET /api/cron/jobs heartbeat reads config", () => {
    it("returns heartbeat interval from openclaw.json when configured", async () => {
      const { existsSync: mockExists, readFileSync: mockReadFile } = await import("node:fs");
      vi.mocked(mockExists).mockImplementation((p) => {
        const s = String(p);
        if (s.endsWith("openclaw.json")) return true;
        if (s.endsWith("jobs.json")) return false;
        return false;
      });
      vi.mocked(mockReadFile).mockImplementation((p) => {
        if (String(p).endsWith("openclaw.json")) {
          return JSON.stringify({
            agents: { defaults: { heartbeat: { every: "2h" } } },
          }) as never;
        }
        return "" as never;
      });

      const { GET } = await import("./jobs/route.js");
      const res = await GET();
      const json = await res.json();
      expect(json.heartbeat.intervalMs).toBe(7_200_000);
      expect(json.heartbeat.every).toBe("2h");
    });

    it("falls back to 1d (24h) when heartbeat config is absent", async () => {
      const { existsSync: mockExists, readFileSync: mockReadFile } = await import("node:fs");
      vi.mocked(mockExists).mockReturnValue(false);
      vi.mocked(mockReadFile).mockReturnValue("" as never);

      const { GET } = await import("./jobs/route.js");
      const res = await GET();
      const json = await res.json();
      expect(json.heartbeat.intervalMs).toBe(86_400_000);
      expect(json.heartbeat.every).toBe("1d");
    });
  });

  // ─── POST /api/cron/heartbeat ──────────────────────────────────

  describe("POST /api/cron/heartbeat", () => {
    it("rejects missing value", async () => {
      const { POST } = await import("./heartbeat/route.js");
      const req = new Request("http://localhost/api/cron/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unit: "m" }),
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
    });

    it("rejects invalid unit", async () => {
      const { POST } = await import("./heartbeat/route.js");
      const req = new Request("http://localhost/api/cron/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: 30, unit: "x" }),
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
    });

    it("rejects non-integer value", async () => {
      const { POST } = await import("./heartbeat/route.js");
      const req = new Request("http://localhost/api/cron/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: 1.5, unit: "m" }),
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
    });

    it("rejects zero value", async () => {
      const { POST } = await import("./heartbeat/route.js");
      const req = new Request("http://localhost/api/cron/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: 0, unit: "m" }),
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
    });

    it("saves a valid heartbeat setting", async () => {
      const { existsSync: mockExists, readFileSync: mockReadFile } = await import("node:fs");
      vi.mocked(mockExists).mockReturnValue(true);
      vi.mocked(mockReadFile).mockReturnValue(JSON.stringify({ gateway: { port: 19001 } }) as never);

      const { POST } = await import("./heartbeat/route.js");
      const req = new Request("http://localhost/api/cron/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: 45, unit: "m" }),
      });
      const res = await POST(req);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.raw).toBe("45m");
      expect(json.intervalMs).toBe(2_700_000);
    });

    it("rejects values exceeding max for unit", async () => {
      const { POST } = await import("./heartbeat/route.js");
      const req = new Request("http://localhost/api/cron/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: 31, unit: "d" }),
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
    });
  });

  // ─── GET /api/cron/heartbeat ───────────────────────────────────

  describe("GET /api/cron/heartbeat", () => {
    it("returns the current heartbeat setting", async () => {
      const { existsSync: mockExists, readFileSync: mockReadFile } = await import("node:fs");
      vi.mocked(mockExists).mockReturnValue(true);
      vi.mocked(mockReadFile).mockReturnValue(
        JSON.stringify({ agents: { defaults: { heartbeat: { every: "1d" } } } }) as never,
      );

      const { GET } = await import("./heartbeat/route.js");
      const res = await GET();
      const json = await res.json();
      expect(json.raw).toBe("1d");
      expect(json.value).toBe(1);
      expect(json.unit).toBe("d");
      expect(json.intervalMs).toBe(86_400_000);
    });
  });
});
