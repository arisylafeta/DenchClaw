import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const send = vi.fn();
vi.mock("@/lib/postgres", () => ({ queryPg: (...args: unknown[]) => query(...args) }));
vi.mock("web-push", () => ({ default: { sendNotification: (...args: unknown[]) => send(...args) } }));
vi.mock("node:fs", () => ({ readFileSync: () => JSON.stringify({ publicKey: "pub", privateKey: "priv", subject: "mailto:a@b.c" }) }));

import { parsePrefs, parseSubscription, pushPublicKey, sendPushToUser } from "./web-push";

const sub = { endpoint: "https://push.example/abc", keys: { p256dh: "p", auth: "a" } };

beforeEach(() => { query.mockReset(); send.mockReset(); });

describe("subscription parsing", () => {
  it("accepts a well-formed https subscription", () => { expect(parseSubscription(sub)).toEqual(sub); });
  it("rejects http endpoints, missing keys and junk", () => {
    expect(parseSubscription({ ...sub, endpoint: "http://push.example/abc" })).toBeNull();
    expect(parseSubscription({ endpoint: sub.endpoint, keys: {} })).toBeNull();
    expect(parseSubscription("x")).toBeNull();
  });
  it("defaults prefs to on and honours explicit false", () => {
    expect(parsePrefs(undefined)).toEqual({ done: true, input: true });
    expect(parsePrefs({ done: false })).toEqual({ done: false, input: true });
  });
  it("exposes the public key from the secret file", () => { expect(pushPublicKey()).toBe("pub"); });
});

describe("sendPushToUser", () => {
  const payload = { kind: "done" as const, title: "t", body: "b", tag: "agent-x", url: "/" };
  it("sends only to devices whose prefs allow the kind", async () => {
    query.mockResolvedValueOnce([
      { endpoint: "https://push.example/on", p256dh: "p", auth: "a", prefs: { done: true, input: true } },
      { endpoint: "https://push.example/off", p256dh: "p", auth: "a", prefs: { done: false, input: true } },
    ]);
    send.mockResolvedValue({});
    expect(await sendPushToUser("u1", payload)).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].endpoint).toBe("https://push.example/on");
    expect(JSON.parse(send.mock.calls[0][1])).toMatchObject({ title: "t", url: "/" });
  });
  it("deletes an endpoint the push service reports gone", async () => {
    query.mockResolvedValueOnce([{ endpoint: "https://push.example/dead", p256dh: "p", auth: "a", prefs: {} }]).mockResolvedValue([]);
    send.mockRejectedValue(Object.assign(new Error("gone"), { statusCode: 410 }));
    expect(await sendPushToUser("u1", payload)).toBe(0);
    expect(query.mock.calls[1][0]).toMatch(/delete from crm_push_subscriptions/);
    expect(query.mock.calls[1][1]).toEqual(["https://push.example/dead"]);
  });
});
