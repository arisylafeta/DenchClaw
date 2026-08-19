// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { MessagesClient } from "./messages-client";
import type { MessageListRow, MessagePage } from "./contract";

const { replace, getMessageDetail } = vi.hoisted(() => ({ replace: vi.fn(), getMessageDetail: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));
vi.mock("./actions", async () => {
  const actual = await vi.importActual<typeof import("./actions")>("./actions");
  return { ...actual, getMessageDetail };
});

const row: MessageListRow = {
  id: "message-1",
  conversation_id: "conversation-1",
  sender_membership_id: "membership-1",
  body: "This is a long message that remains readable in the protected detail view.",
  message_type: "user",
  is_system_seeded: false,
  created_at: "2026-08-19T10:00:00.000Z",
  updated_at: "2026-08-19T10:00:00.000Z",
  moderation_status: "delivered",
  moderation_reason_code: null,
  moderation_reason_text: null,
  moderation_policy_version: "reb124-v1",
  moderation_decision_source: "fail_open",
  moderation_attempt_count: 1,
  moderation_failure_code: "configuration",
  moderation_decided_at: "2026-08-19T10:00:01.000Z",
  attachment_file_name: "photo.jpg",
  attachment_content_type: "image/jpeg",
  attachment_size_bytes: 2048,
  sender: { membershipId: "membership-1", accountId: "supplier-1", displayName: "Sender", email: "sender@example.test", role: "owner" },
  conversation: { id: "conversation-1", type: "purchase", status: "open", supplierAccountId: "supplier-1", supplierName: "Supplier", counterpartyAccountId: "buyer-1", counterpartyName: "Buyer" },
  listing: { id: "listing-1", title: "Battery listing", reference: "REF-1", slug: "battery-listing" },
};
const modelRow: MessageListRow = {
  ...row,
  id: "message-2",
  body: "Model-reviewed message",
  moderation_decision_source: "model",
  moderation_failure_code: null,
};

const initialPage: MessagePage = {
  rows: [row, modelRow],
  totalCount: 2,
  page: 1,
  pageSize: 25,
  totalPages: 1,
  filters: { search: "", from: "", to: "", status: "" },
};

describe("MessagesClient", () => {
  it("renders fail-open configuration deliveries and attachment metadata", () => {
    render(<MessagesClient initialPage={initialPage} />);

    expect(screen.getByText("fail-open")).toBeInTheDocument();
    expect(screen.getByText("model-reviewed")).toBeInTheDocument();
    expect(screen.getByText("configuration")).toBeInTheDocument();
    expect(screen.getAllByText("photo.jpg")).toHaveLength(2);
    expect(screen.getByPlaceholderText("Search message text, sender, account, listing, or conversation...")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Filter by moderation status" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Filter by decision source" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Filter by reason code" })).not.toBeInTheDocument();
    const headings = screen.getAllByRole("columnheader").map((heading) => heading.textContent?.trim());
    expect(headings[0]).toBe("Sender");
    expect(headings).not.toContain("Type");
    expect(headings).not.toContain("Decision time");
  });

  it("opens protected detail with full body and nearby context", async () => {
    const user = userEvent.setup();
    getMessageDetail.mockResolvedValue({ message: row, context: [row] });
    render(<MessagesClient initialPage={initialPage} />);

    await user.click(screen.getByText("This is a long message that remains readable in the protected detail view."));

    expect(await screen.findByRole("dialog", { name: "Message detail" })).toBeInTheDocument();
    expect(screen.getByText("Nearby conversation context")).toBeInTheDocument();
    expect(screen.getAllByText("This is a long message that remains readable in the protected detail view.").length).toBeGreaterThan(1);
    expect(getMessageDetail).toHaveBeenCalledWith("message-1");
  });
});
