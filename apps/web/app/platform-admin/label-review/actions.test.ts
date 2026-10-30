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
