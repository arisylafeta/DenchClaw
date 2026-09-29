import { beforeEach, describe, expect, it, vi } from "vitest";
import { projectCampaignMetrics } from "./campaign-metrics";

const queryPg = vi.hoisted(() => vi.fn());
vi.mock("../postgres", () => ({ queryPg }));

describe("campaign metrics projection", () => {
  beforeEach(() => queryPg.mockReset());

  it("shows per-recipient Postmark receipts on the campaign table without rewriting legacy snapshots", async () => {
    const entries = [
      { entry_id: "pilot", "Invites Sent": 0, "Emails Delivered": 0 },
      { entry_id: "old", "Invites Sent": 104, "Emails Delivered": 0 },
    ];
    queryPg.mockResolvedValueOnce([{ available: true }]).mockResolvedValueOnce([
      { id: "pilot", invites_sent: "2", emails_delivered: "2", emails_opened: "1", emails_clicked: "0", emails_bounced: "0" },
    ]);

    expect(await projectCampaignMetrics(entries)).toEqual([
      { entry_id: "pilot", "Invites Sent": 2, "Emails Delivered": 2, "Emails Opened": 1, "Emails Clicked": 0, "Emails Bounced": 0 },
      entries[1],
    ]);
    expect(queryPg.mock.calls[1][0]).toContain("c.source_system = 'dench-campaign'");
  });

  it("preserves existing campaign rows before the send ledger migration", async () => {
    queryPg.mockResolvedValueOnce([{ available: false }]);
    const entries = [{ entry_id: "old", "Invites Sent": 104 }];
    expect(await projectCampaignMetrics(entries)).toBe(entries);
    expect(queryPg).toHaveBeenCalledTimes(1);
  });
});
