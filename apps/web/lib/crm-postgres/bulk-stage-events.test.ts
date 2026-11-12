import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn(), tx: { query: vi.fn() } }));
vi.mock("../postgres", () => ({
  queryPg: mocks.query,
  withPgTransaction: async <T>(fn: (tx: typeof mocks.tx) => Promise<T>) => fn(mocks.tx),
}));
import { asStageActor, listStageEvents } from "./bulk-stage-events";

describe("stage event actor", () => {
  beforeEach(() => { mocks.query.mockReset(); mocks.tx.query.mockReset(); });

  it("names the signed-in user for the transaction before any write in it", async () => {
    await asStageActor("4f5c0a8e-0000-4000-8000-000000000001", async (tx) => {
      await tx.query("update crm_bulk_offers set stage = 'offered' where id = 'bof_1'");
    });
    const sql = mocks.tx.query.mock.calls.map(([text]) => String(text));
    expect(sql[0]).toMatch(/set_config\('bulk\.actor', coalesce\(\(select email from crm_users where id = \$1::uuid\), 'system'\), true\)/);
    expect(mocks.tx.query.mock.calls[0][1]).toEqual(["4f5c0a8e-0000-4000-8000-000000000001"]);
    expect(sql[1]).toMatch(/update crm_bulk_offers/);
  });

  it("falls back to system without a user, and returns what the work returns", async () => {
    expect(await asStageActor(null, async () => "done")).toBe("done");
    expect(mocks.tx.query.mock.calls[0][1]).toEqual([null]);
  });

  it("reads one subject's history oldest first", async () => {
    mocks.query.mockResolvedValue([]);
    await listStageEvents("offer", "bof_1");
    expect(mocks.query).toHaveBeenCalledWith(expect.stringMatching(/where subject_kind = \$1 and subject_id = \$2 order by occurred_at, id/), ["offer", "bof_1"]);
  });
});
