import { describe, expect, it, vi } from "vitest";
import { getRegisteredEntryDetail } from "./registered-entry-detail";

const queryPg = vi.hoisted(() => vi.fn().mockResolvedValue([]));
vi.mock("../postgres", () => ({ queryPg }));

describe("registered entry details", () => {
  it("does not attach a detail payload to unregistered objects", async () => {
    await expect(getRegisteredEntryDetail("people", "p1", "user-1")).resolves.toBeUndefined();
  });
});
