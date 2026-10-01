import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeCampaignPostHogReceipt, queryCampaignPostHog } from "./campaign-posthog";

const ID = "a".repeat(32);
const START = "2026-09-24T15:00:00.000Z";
const END = "2026-10-01T10:00:00.000Z";
const NOW = Date.parse(END);
const COLUMNS = ["link_id", "event", "submission_kind", "session_id", "event_count", "first_at", "last_at"];
const complete = { columns: COLUMNS, last_refresh: END, hasMore: false, results: [] };
const fetchMock = vi.fn();
let directory: string;
let path: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "campaign-provider-"));
  path = join(directory, "credentials.json");
  vi.stubEnv("CRM_POSTHOG_CREDENTIALS_PATH", path);
  vi.stubGlobal("fetch", fetchMock);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(END));
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  await rm(directory, { recursive: true, force: true });
});

describe("PostHog complete evidence receipt", () => {
  it("accepts complete zero and complete responses beyond the provider's default hundred rows", () => {
    expect(decodeCampaignPostHogReceipt(complete, new Set([ID]), START, END, null, NOW, NOW)).toEqual({ events: [], observed_at: END });
    const rows = Array.from({ length: 150 }, (_, index) => [ID, "campaign_page_viewed", null, `session-${index}`, 2,
      "2026-09-25 10:00:00", "2026-09-25 11:00:00"]);
    const decoded = decodeCampaignPostHogReceipt({ columns: COLUMNS, last_refresh: END, results: rows }, new Set([ID]), START, END, null, NOW, NOW);
    expect(decoded.events.reduce((sum, event) => sum + event.event_count, 0)).toBe(300);
    expect(decoded.events[0]).toMatchObject({ first_at: "2026-09-25T10:00:00.000Z", last_at: "2026-09-25T11:00:00.000Z" });
  });

  it("accepts the live provider's nullable pagination marker below the explicit query cap", () => {
    const receipt = { ...complete, hasMore: null, results: [
      [ID, "campaign_page_viewed", null, "browser-session", 2, "2026-09-25T10:00:00.123456Z", "2026-09-25T11:00:00.123456Z"],
    ] };
    const decoded = decodeCampaignPostHogReceipt(receipt, new Set([ID]), START, END, null, NOW, NOW);
    expect(decoded.events.reduce((sum, event) => sum + event.event_count, 0)).toBe(2);
    expect(() => decodeCampaignPostHogReceipt({ ...receipt, results: Array(50_000).fill(receipt.results[0]) },
      new Set([ID]), START, END, null, NOW, NOW)).toThrow("provider_incomplete");
  });

  it.each([
    { ...complete, hasMore: true },
    { ...complete, results: Array(50_000).fill([]) },
    { ...complete, error: "private provider details" },
    { ...complete, results: [[ID, "campaign_page_viewed", null, "session", 1, "2026-09-23T00:00:00Z", "2026-09-25T00:00:00Z"]] },
    { ...complete, results: [["b".repeat(32), "campaign_page_viewed", null, "session", 1, START, START]] },
    { ...complete, results: [[ID, "public_auction_submission_created", "unknown", null, 1, START, START]] },
  ])("rejects partial, out-of-period, unknown-link, and invalid event receipts", (payload) => {
    expect(() => decodeCampaignPostHogReceipt(payload, new Set([ID]), START, END, null, NOW, NOW)).toThrow("provider_incomplete");
  });

  it("uses actual cached refresh time, or a validated HTTP receipt, never a manufactured current timestamp", () => {
    const old = "2026-09-30T10:00:00.000Z";
    expect(decodeCampaignPostHogReceipt({ ...complete, last_refresh: old }, new Set([ID]), START, END, null, NOW, NOW).observed_at).toBe(old);
    const noRefresh = { columns: COLUMNS, results: [], hasMore: false };
    expect(decodeCampaignPostHogReceipt(noRefresh, new Set([ID]), START, END, new Date(NOW).toUTCString(), NOW, NOW).observed_at).toBe(END);
    expect(() => decodeCampaignPostHogReceipt(noRefresh, new Set([ID]), START, END, null, NOW, NOW)).toThrow("provider_incomplete");
    expect(() => decodeCampaignPostHogReceipt(noRefresh, new Set([ID]), START, END, new Date(NOW - 600_000).toUTCString(), NOW, NOW)).toThrow("provider_incomplete");
  });
});

describe("private credential boundary", () => {
  it.each([
    { host: "https://attacker.invalid", env_id: 375247, token: "secret-token" },
    { host: "https://us.posthog.com/attacker", env_id: 375247, token: "secret-token" },
    { host: "http://localhost", env_id: 375247, token: "secret-token" },
    { host: "https://us.posthog.com", env_id: 999, token: "secret-token" },
  ])("rejects untrusted hosts and the wrong project before transmitting a credential", async (credentials) => {
    await writeFile(path, JSON.stringify(credentials), { mode: 0o600 });
    await expect(queryCampaignPostHog("customer", [ID], START, END)).rejects.toThrow("credentials_missing");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects readable-by-others credentials and symlinks", async () => {
    await writeFile(path, JSON.stringify({ host: "https://us.posthog.com", env_id: "375247", token: "secret-token" }), { mode: 0o600 });
    await chmod(path, 0o644);
    await expect(queryCampaignPostHog("customer", [ID], START, END)).rejects.toThrow("credentials_missing");
    await chmod(path, 0o600);
    const linked = join(directory, "linked.json");
    await symlink(path, linked);
    vi.stubEnv("CRM_POSTHOG_CREDENTIALS_PATH", linked);
    await expect(queryCampaignPostHog("customer", [ID], START, END)).rejects.toThrow("credentials_missing");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns safe failure codes rather than leaking provider responses or credentials", async () => {
    await writeFile(path, JSON.stringify({ host: "https://eu.posthog.com", env_id: 375247, token: "secret-token" }), { mode: 0o600 });
    fetchMock.mockResolvedValueOnce(new Response("secret-token and provider private details", { status: 403 }));
    await expect(queryCampaignPostHog("customer", [ID], START, END)).rejects.toThrow("provider_unavailable");
    fetchMock.mockResolvedValueOnce(Response.json({ ...complete, hasMore: true }));
    await expect(queryCampaignPostHog("customer", [ID], START, END)).rejects.toThrow("provider_incomplete");
  });

  it("aborts a stalled provider rather than leaving the activity request hanging", async () => {
    await writeFile(path, JSON.stringify({ host: "https://us.posthog.com", env_id: 375247, token: "secret-token" }), { mode: 0o600 });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(END));
    const { promise: started, resolve: requested } = Promise.withResolvers<void>();
    fetchMock.mockImplementationOnce((_url: string, options: RequestInit) => {
      requested();
      const { promise, reject } = Promise.withResolvers<Response>();
      options.signal!.addEventListener("abort", () => { reject(new Error("private upstream failure")); }, { once: true });
      return promise;
    });
    const pending = queryCampaignPostHog("customer", [ID], START, END);
    const rejected = expect(pending).rejects.toThrow("provider_unavailable");
    await started;
    await vi.advanceTimersByTimeAsync(20_000);
    await rejected;
  });
});
