import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  canReadWhatsapp,
  decideWhatsappIdentity,
  whatsappConversation,
  whatsappPagination,
  whatsappThreads,
} from "./whatsapp";
const { query, transactionQuery } = vi.hoisted(() => ({
  query: vi.fn(),
  transactionQuery: vi.fn(),
}));
vi.mock("../postgres", () => ({
  queryPg: query,
  withPgTransaction: (fn: (client: { query: typeof transactionQuery }) => unknown) =>
    fn({ query: transactionQuery }),
}));
beforeEach(() => vi.resetAllMocks());
describe("WhatsApp local context", () => {
  it("enforces bounded pagination and current operator access", () => {
    expect(canReadWhatsapp({ id: "operator" })).toBe(true);
    expect(canReadWhatsapp(null)).toBe(false);
    expect(whatsappPagination(200, 3)).toEqual({ limit: 200, offset: 3 });
    for (const args of [
      [0, 0],
      [201, 0],
      [1.5, 0],
      [50, -1],
      [50, NaN],
    ]) {
      expect(() => whatsappPagination(...args)).toThrow("invalid_pagination");
    }
  });
  it("discovers groups through active links and company members, not copied participant names", async () => {
    query.mockResolvedValue([{ id: "group", kind: "group", shared_context: true }]);
    const result = await whatsappThreads({ companyId: "company" }, 20, 40);
    expect(result.threads[0].shared_context).toBe(true);
    expect(query.mock.calls[0][1]).toEqual([null, "company", null, 20, 40]);
    expect(query.mock.calls[0][0]).toContain("l.valid_to is null");
    expect(query.mock.calls[0][0]).toContain("p.company_id=$2");
    expect(query.mock.calls[0][0]).toContain("whatsapp_thread_member");
  });
  it("requires explicit live thread or message evidence for trade context", async () => {
    query.mockResolvedValue([]);
    await whatsappThreads({ tradeId: "trade" });
    expect(query.mock.calls[0][1]).toEqual([null, null, "trade", 50, 0]);
    // Trade context comes from WhatsApp thread links on the Trades Preview listing, never rejected ones.
    expect(query.mock.calls[0][0]).toContain("from crm_bulk_thread_links e");
    expect(query.mock.calls[0][0]).toContain("e.channel='whatsapp'");
    expect(query.mock.calls[0][0]).toContain("e.state<>'rejected'");
  });
  it("preserves tombstones/replies and masks deleted, expired and view-once reply bodies", async () => {
    query
      .mockResolvedValueOnce([{ id: "thread" }])
      .mockResolvedValueOnce([{ id: "deleted", deleted_at: "2026-01-01", body: null }])
      .mockResolvedValueOnce([]);
    const result = await whatsappConversation("thread", 10, 2);
    expect(result?.messages[0].body).toBeNull();
    expect(result?.history_complete).toBe(false);
    const sql = query.mock.calls[1][0];
    expect(sql).toContain("r.deleted_at is not null");
    expect(sql).toContain("r.metadata->'flags'->>'viewOnce'");
    expect(sql).toContain("expiresAt");
    expect(sql).toContain("order by m.occurred_at,m.id");
    expect(query.mock.calls[1][1]).toEqual(["thread", 10, 2]);
  });
  it("does not query messages for a missing thread", async () => {
    query.mockResolvedValue([]);
    expect(await whatsappConversation("missing")).toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });
  it("refuses reassignment until an existing non-shared decision is revoked", async () => {
    transactionQuery
      .mockResolvedValueOnce({ rows: [{ id: "identity", shared: false }] })
      .mockResolvedValueOnce({ rows: [{ id: "old", person_id: "old-person", company_id: null }] });
    await expect(
      decideWhatsappIdentity("identity", { personId: "new-person" }, "operator"),
    ).rejects.toThrow("identity_already_linked");
    expect(transactionQuery).toHaveBeenCalledTimes(2);
  });
  it("is idempotent for the same target and retains the original decision", async () => {
    transactionQuery
      .mockResolvedValueOnce({ rows: [{ id: "identity" }] })
      .mockResolvedValueOnce({ rows: [{ id: "old", person_id: "person", company_id: null }] });
    expect(await decideWhatsappIdentity("identity", { personId: "person" }, "operator")).toEqual({
      id: "old",
    });
    expect(transactionQuery).toHaveBeenCalledTimes(2);
  });
  it("revokes only the selected identity's active link with actor evidence", async () => {
    transactionQuery
      .mockResolvedValueOnce({ rows: [{ id: "identity" }] })
      .mockResolvedValueOnce({ rows: [{ id: "link" }] });
    expect(await decideWhatsappIdentity("identity", { unlinkId: "link" }, "operator")).toEqual({
      id: "link",
    });
    expect(transactionQuery.mock.calls[1][0]).toContain("identity_id=$2 and valid_to is null");
    expect(transactionQuery.mock.calls[1][1]).toEqual([
      "link",
      "identity",
      '{"revoked_by":"operator"}',
    ]);
  });
});
