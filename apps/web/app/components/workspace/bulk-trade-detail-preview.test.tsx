// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { BulkTradeDetailPreview } from "./bulk-trade-detail-preview";

describe("Bulk Trade detail preview", () => {
  it("shows buyers and each evidence channel without creating transaction state", () => {
    const navigate = vi.fn();
    render(<BulkTradeDetailPreview
      detail={{
        kind: "bulk_trade",
        parties: [{ id: "buyer-1", role: "buyer", display_name: "Battery Buyer", company_id: "company-1", channel: "WhatsApp" }],
        whatsappMessages: [{ id: "wa-1", relationship: "supports", conversation: "Trade chat", sender: "Buyer", body: "Can collect next week." }],
        gmailThreads: [{ id: "thread-1", relationship: "supports", accessible: true, mailbox_owner_email: "alex@rebattery.io", subject: "Collection plan", message_count: 1, messages: [{ id: "email-1", from_email: "buyer@example.com", body_preview: "Please send the address." }] }],
        opportunities: [{ id: "opp-1", relationship: "conflicts_with_quantity", title: "Legacy lot", quantity: 10 }],
      }}
      onNavigateEntry={navigate}
    />);

    expect(screen.getByText("Evidence workspace preview").style.color).toBe("var(--color-text)");
    expect(screen.getByText("Battery Buyer")).toBeTruthy();
    expect(screen.getByText("Can collect next week.")).toBeTruthy();
    expect(screen.getByText("Please send the address.")).toBeTruthy();
    expect(screen.getByText("alex@rebattery.io")).toBeTruthy();
    expect(screen.getByText("conflicts with quantity")).toBeTruthy();
    expect(screen.queryByText(/offer status/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Battery Buyer/ }));
    expect(navigate).toHaveBeenCalledWith("company", "company-1");
  });
});
