import { describe, expect, it, vi } from "vitest";
import { readAllRows, readAllRowsInBatches, readRowsInBatches } from "./queries";

describe("platform admin query bounds", () => {
  it("deduplicates and batches large URL filters", async () => {
    const loadBatch = vi.fn(async (ids: string[]) => ({
      data: ids.map((id) => ({ id })),
      error: null,
    }));
    const ids = [...Array.from({ length: 205 }, (_, index) => `id-${index}`), "id-0"];

    const rows = await readRowsInBatches(ids, loadBatch);

    expect(loadBatch).toHaveBeenCalledTimes(3);
    expect(loadBatch.mock.calls.map(([batch]) => batch.length)).toEqual([100, 100, 5]);
    expect(rows).toHaveLength(205);
  });

  it("reads through response caps until the final short page", async () => {
    const loadPage = vi.fn(async (from: number, to: number) => ({
      data: from === 0 ? [{ id: 1 }, { id: 2 }] : [{ id: 3 }],
      error: null,
    }));

    const rows = await readAllRows(loadPage, { pageSize: 2, maxRows: 10 });

    expect(loadPage).toHaveBeenNthCalledWith(1, 0, 1);
    expect(loadPage).toHaveBeenNthCalledWith(2, 2, 3);
    expect(rows).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  it("fails instead of silently truncating at a safety limit", async () => {
    await expect(readAllRows(
      async () => ({ data: [{ id: 1 }, { id: 2 }], error: null }),
      { pageSize: 2, maxRows: 4 },
    )).rejects.toThrow("row safety limit");
  });

  it("paginates every bounded filter batch", async () => {
    const loadPage = vi.fn(async (ids: string[], from: number) => ({
      data: from === 0
        ? [{ id: `${ids[0]}-a` }, { id: `${ids[0]}-b` }]
        : [{ id: `${ids[0]}-c` }],
      error: null,
    }));

    const rows = await readAllRowsInBatches(
      Array.from({ length: 105 }, (_, index) => `id-${index}`),
      loadPage,
      { pageSize: 2, maxRowsPerBatch: 10 },
    );

    expect(loadPage).toHaveBeenCalledTimes(4);
    expect(rows).toHaveLength(6);
  });
});
