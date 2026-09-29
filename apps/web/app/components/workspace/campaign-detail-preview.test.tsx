// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CampaignDetailPreview } from "./campaign-detail-preview";

describe("campaign recipient detail", () => {
  it("links the invited person and distinguishes provider events from a site visit", () => {
    const onNavigateEntry = vi.fn();
    render(<CampaignDetailPreview onNavigateEntry={onNavigateEntry} recipients={[{
      person_id: "p1", person_name: "Alex", recipient_email: "alex@rebattery.io",
      state: "accepted", provider_message_id: "postmark-1", accepted_at: "2026-09-23T11:03:00Z",
      delivered_at: "2026-09-23T11:03:18Z", bounced_at: null,
      provider_opened_at: "2026-09-23T11:03:22Z", provider_link_clicked_at: "2026-09-23T11:04:00Z",
    }]} />);

    expect(screen.getByText("Invited people (1)")).toBeInTheDocument();
    expect(screen.getByText(/Delivered · Provider open recorded · Auction email link clicked \(site visit unverified\)/)).toBeInTheDocument();
    expect(screen.getByText("Postmark ID: postmark-1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "Alex" }));
    expect(onNavigateEntry).toHaveBeenCalledWith("people", "p1");
  });
});
