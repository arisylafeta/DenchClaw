import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import { canonicalPostmarkTime, postmarkOpenEventId } from "@/lib/postmark-mail-webhook";

const queryPg = vi.hoisted(() => vi.fn());
vi.mock("@/lib/postgres", () => ({ queryPg }));
const payload = { RecordType: "Open", MessageID: "provider-1", Recipient: "synthetic@example.com", ReceivedAt: "2026-10-08T12:00:00.123456Z", FirstOpen: true, Client: { Name: "Chrome" } };
const request = (body: unknown = payload, auth: string | null = "Basic " + Buffer.from("test-user:test-password").toString("base64")) => new Request("https://example.com/api/webhooks/postmark-mail", {
  method: "POST", body: JSON.stringify(body), headers: auth ? { authorization: auth } : {},
});

beforeEach(() => {
  vi.stubEnv("POSTMARK_MAIL_WEBHOOK_USER", "test-user");
  vi.stubEnv("POSTMARK_MAIL_WEBHOOK_PASSWORD", "test-password");
  queryPg.mockReset();
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("Postmark Open receiver", () => {
  it("refuses missing, incorrect and malformed credentials before touching the database", async () => {
    for (const auth of [null, "Bearer token", "Basic !!!", "Basic " + Buffer.from("wrong:credentials").toString("base64")]) {
      expect((await POST(request(payload, auth))).status).toBe(401);
    }
    for (const name of ["POSTMARK_MAIL_WEBHOOK_USER", "POSTMARK_MAIL_WEBHOOK_PASSWORD"]) {
      vi.stubEnv(name, "");
      expect((await POST(request())).status).toBe(401);
      vi.stubEnv(name, name.endsWith("USER") ? "test-user" : "test-password");
    }
    expect(queryPg).not.toHaveBeenCalled();
  });

  it("ignores non-open records with 200", async () => {
    const response = await POST(request({ RecordType: "Delivery" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ignored" });
    expect(queryPg).not.toHaveBeenCalled();
  });

  it("retries unknown messages without logging personal data", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    queryPg.mockResolvedValueOnce([]);
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Message not yet available" });
    expect(queryPg).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("Postmark mail webhook awaiting messages", { count: 1 });
  });

  it("records repeat opens, makes redeliveries idempotent and shares API-sync keys", async () => {
    const stored = new Map<string, unknown>();
    queryPg.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.startsWith("select id")) {return [{ id: "m1" }];}
      expect(sql).toContain("'postmark'");
      expect(sql).toContain("do update set detail");
      const key = String(params[1]);
      if (stored.has(key)) {return [];}
      stored.set(key, JSON.parse(String(params[3])));
      return [{ id: "event", inserted: true }];
    });
    expect(await (await POST(request())).json()).toEqual({ status: "recorded", inserted: 1 });
    expect(await (await POST(request())).json()).toEqual({ status: "duplicate", inserted: 0 });
    const repeat = { ...payload, FirstOpen: false, ReceivedAt: "2026-10-08T12:11:00Z", UserAgent: "Normal browser" };
    expect(await (await POST(request(repeat))).json()).toEqual({ status: "recorded", inserted: 1 });
    expect(await (await POST(request(repeat))).json()).toEqual({ status: "duplicate", inserted: 0 });
    expect(stored.size).toBe(2);
    // Generated with Python hashlib.sha256(json.dumps(..., sort_keys=True).encode()).
    expect([...stored.keys()][0]).toBe("4ad7da4cc6dc45fff9ecfbbe4d5f19ba1c373f202757e626e3ba94eedd214e77");
    expect([...stored.values()][1]).toMatchObject({ Type: "Opened", Details: { Summary: "Email opened" }, FirstOpen: false, UserAgent: "Normal browser" });
  });

  it("deduplicates a first open already imported by API sync", async () => {
    queryPg.mockResolvedValueOnce([{ id: "m1" }]).mockResolvedValueOnce([]);
    expect(await (await POST(request())).json()).toMatchObject({ status: "duplicate", inserted: 0 });
    expect(queryPg.mock.calls[1][1][1]).toBe("4ad7da4cc6dc45fff9ecfbbe4d5f19ba1c373f202757e626e3ba94eedd214e77");
  });

  it("caps streamed bytes without Content-Length and cancels before reading the rest", async () => {
    const cancel = vi.fn();
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        // Multibyte UTF-8 must be counted as bytes, not characters.
        controller.enqueue(new TextEncoder().encode("é".repeat(20000)));
      }, cancel,
    }, { highWaterMark: 0 });
    const streamed = new Request("https://example.com", {
      method: "POST", headers: { authorization: request().headers.get("authorization")! },
      body, duplex: "half",
    } as RequestInit & { duplex: string });
    expect(streamed.headers.has("content-length")).toBe(false);
    expect((await POST(streamed)).status).toBe(413);
    expect(pulls).toBe(2);
    expect(cancel).toHaveBeenCalledOnce();
    expect(queryPg).not.toHaveBeenCalled();
  });

  it("accepts the byte limit exactly and bounds nested stored metadata", async () => {
    queryPg.mockResolvedValue([{ id: "m1", inserted: true }]);
    const large = { ...payload, UserAgent: "u".repeat(900), Client: { Name: "c".repeat(900) }, Geo: { City: "g".repeat(900) }, Platform: "p".repeat(900), Recipient: "r".repeat(900) };
    const json = JSON.stringify(large);
    const exact = new Request("https://example.com", {
      method: "POST", headers: { authorization: request().headers.get("authorization")! },
      body: json + " ".repeat(65536 - Buffer.byteLength(json)),
    });
    expect((await POST(exact)).status).toBe(200);
    const detail = JSON.parse(queryPg.mock.calls[1][1][3]);
    expect(detail.UserAgent).toHaveLength(512);
    expect(detail.Client.Name).toHaveLength(256);
    expect(detail.Geo.City).toHaveLength(256);
    expect(detail.Platform).toHaveLength(256);
    expect(detail.Recipient).toHaveLength(256);
  });

  it("rejects invalid payloads and returns retryable database errors without leaking parameters", async () => {
    for (const body of [null, [], { ...payload, ReceivedAt: "bad" }, { ...payload, MessageID: null }]) {
      expect((await POST(request(body))).status).toBe(400);
    }
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    queryPg.mockRejectedValueOnce(new Error("sensitive parameters"));
    expect((await POST(request())).status).toBe(500);
    expect(log).toHaveBeenCalledWith("Postmark mail webhook ingestion failed");
  });

  it("canonicalises timestamps exactly like Python without discarding microseconds", () => {
    expect(canonicalPostmarkTime(payload.ReceivedAt)).toBe("2026-10-08T12:00:00.123456+00:00");
    expect(canonicalPostmarkTime("2026-10-08T13:00:00.1234567+01:00")).toBe("2026-10-08T12:00:00.123456+00:00");
    expect(canonicalPostmarkTime("2026-02-30T12:00:00Z")).toBeNull();
    expect(canonicalPostmarkTime("2026-10-08T12:00:00.000Z")).toBe("2026-10-08T12:00:00+00:00");
    expect(canonicalPostmarkTime("2026-10-08T12:00:00.1")).toBe("2026-10-08T12:00:00.100000+00:00");
    expect(postmarkOpenEventId("m1", "2026-10-08T12:00:00.123456+00:00")).toBe("4ad7da4cc6dc45fff9ecfbbe4d5f19ba1c373f202757e626e3ba94eedd214e77");
  });
});
