import { beforeEach, describe, expect, it, vi } from "vitest";

const currentUser = vi.fn();
const readEntry = vi.fn();
const readLabelQueue = vi.fn();
const stockCli = vi.fn();
const currentItemVersion = vi.fn();

vi.mock("next/cache", () => ({ unstable_noStore: vi.fn() }));
vi.mock("@/lib/auth", () => ({ currentUser }));
vi.mock("./stock-source", () => ({ readEntry, readLabelQueue, stockCli, currentItemVersion }));

const OBS = "11111111-1111-4111-8111-111111111111";
const ITEM = "22222222-2222-4222-8222-222222222222";
const entry = { observationId: OBS, itemId: ITEM, photoUrl: "https://cdn.example/p.jpg", photoNumber: 5, decision: null };

describe("recordLabelDecision", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentUser.mockResolvedValue({ id: "u1", email: "ari@example.com" });
    readEntry.mockResolvedValue(entry);
    stockCli.mockResolvedValue("{}");
    currentItemVersion.mockResolvedValue(24);
  });

  it("refuses when signed out and writes nothing", async () => {
    currentUser.mockResolvedValue(null);
    const { recordLabelDecision } = await import("./actions");
    expect(await recordLabelDecision({ observationId: OBS, decision: "approve", note: "" })).toMatchObject({ ok: false });
    expect(stockCli).not.toHaveBeenCalled();
  });

  it("approve appends one observation as the signed-in person", async () => {
    const { recordLabelDecision } = await import("./actions");
    expect(await recordLabelDecision({ observationId: OBS, decision: "approve", note: "ok" })).toEqual({ ok: true, observationId: OBS });
    expect(stockCli).toHaveBeenCalledTimes(1);
    expect(stockCli.mock.calls[0][0]).toEqual(["observe", ITEM]);
    expect(stockCli.mock.calls[0][2]).toBe("crm:ari@example.com");
  });

  it("correct sets the value first with the current item version, then records the decision", async () => {
    const { recordLabelDecision } = await import("./actions");
    await recordLabelDecision({ observationId: OBS, decision: "correct", note: "label", correctedKwh: 82 });
    expect(stockCli.mock.calls.map((c) => c[0][0])).toEqual(["user-update", "observe"]);
    const row = stockCli.mock.calls[0][1].rows[0];
    expect(row).toMatchObject({ itemId: ITEM, expectedVersion: 24, changes: { "listingData.packKwh": { set: 82 } } });
  });

  it("does not record a decision when the correction fails", async () => {
    stockCli.mockRejectedValueOnce(new Error("CONFLICT: stale version\nstack"));
    const { recordLabelDecision } = await import("./actions");
    const result = await recordLabelDecision({ observationId: OBS, decision: "correct", note: "", correctedKwh: 82 });
    expect(result).toEqual({ ok: false, error: "CONFLICT: stale version" });
    expect(stockCli).toHaveBeenCalledTimes(1);
  });

  it("refuses an entry that was already checked", async () => {
    readEntry.mockResolvedValue({ ...entry, decision: { decision: "approve", by: "crm:alex@example.com", note: "", at: "x" } });
    const { recordLabelDecision } = await import("./actions");
    expect(await recordLabelDecision({ observationId: OBS, decision: "approve", note: "" })).toMatchObject({ ok: false });
    expect(stockCli).not.toHaveBeenCalled();
  });
});

describe("recordLabelGroupDecision", () => {
  const OBS2 = "33333333-3333-4333-8333-333333333333";
  const ITEM2 = "44444444-4444-4444-8444-444444444444";
  const e1 = { ...entry, itemId: ITEM };
  const e2 = { ...entry, observationId: OBS2, itemId: ITEM };
  const e3 = { ...entry, observationId: "55555555-5555-4555-8555-555555555555", itemId: ITEM2 };

  beforeEach(() => {
    vi.clearAllMocks();
    currentUser.mockResolvedValue({ id: "u1", email: "ari@example.com" });
    readLabelQueue.mockResolvedValue({ entries: [e1, e2, e3] });
    stockCli.mockResolvedValue("{}");
    currentItemVersion.mockResolvedValue(7);
  });

  it("approves every pending reading, one observation each", async () => {
    const { recordLabelGroupDecision } = await import("./actions");
    const r = await recordLabelGroupDecision({ observationIds: [e1.observationId, e2.observationId, e3.observationId], decision: "approve", note: "" });
    expect(r).toEqual({ ok: true, done: 3, skipped: 0 });
    expect(stockCli.mock.calls.map((c) => c[0][0])).toEqual(["observe", "observe", "observe"]);
  });

  it("corrects once per row, not once per reading, then records every reading", async () => {
    const { recordLabelGroupDecision } = await import("./actions");
    await recordLabelGroupDecision({ observationIds: [e1.observationId, e2.observationId, e3.observationId], decision: "correct", note: "label", correctedKwh: 26 });
    const verbs = stockCli.mock.calls.map((c) => `${c[0][0]}:${c[0][1]}`);
    expect(verbs.filter((v) => v.startsWith("user-update"))).toEqual([`user-update:${ITEM}`, `user-update:${ITEM2}`]);
    expect(verbs.filter((v) => v.startsWith("observe")).length).toBe(3);
  });

  it("skips readings that were already checked and stops with a count when a write fails", async () => {
    readLabelQueue.mockResolvedValue({ entries: [e1, { ...e2, decision: { decision: "approve", by: "x", note: "", at: "y" } }, e3] });
    stockCli.mockResolvedValueOnce("{}").mockRejectedValueOnce(new Error("CONFLICT: stale\nstack"));
    const { recordLabelGroupDecision } = await import("./actions");
    const r = await recordLabelGroupDecision({ observationIds: [e1.observationId, e2.observationId, e3.observationId], decision: "approve", note: "" });
    expect(r).toEqual({ ok: false, error: "CONFLICT: stale (1 of 2 saved)", done: 1 });
  });

  it("writes nothing when signed out", async () => {
    currentUser.mockResolvedValue(null);
    const { recordLabelGroupDecision } = await import("./actions");
    expect(await recordLabelGroupDecision({ observationIds: [e1.observationId], decision: "approve", note: "" })).toMatchObject({ ok: false, done: 0 });
    expect(stockCli).not.toHaveBeenCalled();
  });
});

