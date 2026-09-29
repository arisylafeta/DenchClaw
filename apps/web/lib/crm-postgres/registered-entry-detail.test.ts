import { beforeEach, describe, expect, it, vi } from "vitest";

const queryPg = vi.hoisted(() => vi.fn());
vi.mock("../postgres", () => ({ queryPg }));

describe("registered entry details", () => {
  beforeEach(() => {
    queryPg.mockReset();
    queryPg.mockImplementation(async (sql: string) => {
      if (sql.includes("crm_bulk_trade_parties")) {
        return [{ id: "party-1", role: "buyer", display_name: "Candidate buyer" }];
      }
      if (sql.includes("crm_trade_evidence_messages")) {
        return [{ id: "wa-1", relationship: "supports", conversation: "Trade chat", body: "Interested" }];
      }
      if (sql.includes("crm_email_threads")) {
        return [{ id: "thread-1", relationship: "supports", subject: "Battery stock", messages: [] }];
      }
      if (sql.includes("crm_commercial_opportunities")) {
        return [{ id: "opp-1", relationship: "possible_same_lot", title: "Legacy opportunity" }];
      }
      return [];
    });
  });

  it("loads the evidence-backed Bulk Trade detail and scopes Gmail to the viewer", async () => {
    const { getRegisteredEntryDetail } = await import("./registered-entry-detail");
    const detail = await getRegisteredEntryDetail(
      "bulk_trade",
      "bulk-panasonic-oklahoma",
      "11111111-1111-4111-8111-111111111111",
    );

    expect(detail).toMatchObject({
      kind: "bulk_trade",
      parties: [{ role: "buyer", display_name: "Candidate buyer" }],
      whatsappMessages: [{ body: "Interested" }],
      gmailThreads: [{ subject: "Battery stock" }],
      opportunities: [{ relationship: "possible_same_lot" }],
    });
    const gmailCall = queryPg.mock.calls.find(([sql]) => String(sql).includes("crm_email_threads"));
    expect(gmailCall?.[1]).toEqual([
      "bulk-panasonic-oklahoma",
      "11111111-1111-4111-8111-111111111111",
    ]);
    expect(String(gmailCall?.[0])).toContain("lower(viewer.email) in ('ari@rebattery.io', 'alex@rebattery.io')");
    expect(String(gmailCall?.[0])).toContain("message.thread_id = thread.id and viewer.id is not null");
  });

  it("does not attach a detail payload to unregistered objects", async () => {
    const { getRegisteredEntryDetail } = await import("./registered-entry-detail");
    await expect(getRegisteredEntryDetail("people", "p1", "user-1")).resolves.toBeUndefined();
    expect(queryPg).not.toHaveBeenCalled();
  });
});
