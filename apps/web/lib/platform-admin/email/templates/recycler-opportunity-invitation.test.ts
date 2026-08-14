import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendRawEmail } = vi.hoisted(() => ({
  sendRawEmail: vi.fn(),
}));

vi.mock("@/lib/platform-admin/email/send", () => ({
  sendRawEmail,
}));

import { sendRecyclerOpportunityInvitationEmail } from "./recycler-opportunity-invitation";

describe("recycler opportunity invitation email", () => {
  beforeEach(() => {
    sendRawEmail.mockReset();
    sendRawEmail.mockResolvedValue({ success: true, messageId: "message-id" });
  });

  it("escapes listing values included in the summary HTML", async () => {
    await sendRecyclerOpportunityInvitationEmail("recycler@example.com", {
      recipient_name: "Recycler",
      listing_title: "Listing",
      units: 2,
      manufacturer: "Maker",
      model: "Pack",
      unit_format: "units",
      chemistry: "LFP",
      total_weight_kg: '<img src=x onerror="alert(1)">',
      application: "Storage",
      country: "UK<script>alert(1)</script>",
      listing_url: "https://example.com/listing",
    });

    const html = sendRawEmail.mock.calls[0][0].html as string;
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img src=x");
  });
});
