// @vitest-environment jsdom
import { createElement } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Thread } from "./types";
import { pickSenderDisplay, ThreadListRow } from "./thread-list-row";

function makeThread(overrides: Partial<Thread>): Thread {
  return {
    id: "thread_1",
    subject: "subject",
    last_message_at: "2026-05-04T00:00:00.000Z",
    message_count: 1,
    gmail_thread_id: "gmail_thread_1",
    participants: [],
    participant_ids: [],
    snippet: "snippet",
    primary_sender_type: "Person",
    primary_sender_id: null,
    primary_sender_name: null,
    primary_sender_email: null,
    ...overrides,
  };
}

describe("pickSenderDisplay", () => {
  it("shows a wide-log counterparty without requiring a CRM person", () => {
    expect(pickSenderDisplay(makeThread({ primary_sender_email: "synthetic@example.test" }))).toMatchObject({ email: "synthetic@example.test" });
  });
  it("shows the counterparty when the server classifies the latest sender as self", () => {
    const thread = makeThread({
      primary_sender_id: "p_rebattery",
      primary_sender_name: "Alex",
      primary_sender_email: "alex@rebattery.io",
      is_self: true,
      participants: [
        { id: "p_rebattery", name: "Alex", email: "alex@rebattery.io", avatar_url: null },
        { id: "p_jake", name: "Jake Carpenter", email: "jake.carpenter@gmail.com", avatar_url: null },
      ],
      participant_ids: ["p_rebattery", "p_jake"],
    });

    expect(pickSenderDisplay(thread)).toEqual({
      name: "Jake Carpenter",
      email: "jake.carpenter@gmail.com",
      avatar_url: null,
    });
  });

  it("keeps sender display when latest sender is external", () => {
    const thread = makeThread({
      primary_sender_id: "p_jake",
      primary_sender_name: "Jake Carpenter",
      primary_sender_email: "jake.carpenter@gmail.com",
      participants: [
        { id: "p_jake", name: "Jake Carpenter", email: "jake.carpenter@gmail.com", avatar_url: null },
        { id: "p_rebattery", name: "Alex", email: "alex@rebattery.io", avatar_url: null },
      ],
      participant_ids: ["p_jake", "p_rebattery"],
    });

    expect(pickSenderDisplay(thread)).toEqual({
      name: "Jake Carpenter",
      email: "jake.carpenter@gmail.com",
      avatar_url: null,
    });
  });
});

describe("two-line thread row", () => {
  function row(read: boolean, thread: Partial<Thread> = {}) {
    const onSelect = vi.fn(), onToggleSelected = vi.fn(), onToggleStarred = vi.fn();
    const result = render(createElement(ThreadListRow, { thread: makeThread({ primary_sender_email: "buyer@example.test", ...thread }), selected: false, read, starred: false, inBulkSelection: false, onSelect, onToggleSelected, onToggleStarred }));
    return { ...result, onSelect, onToggleSelected, onToggleStarred };
  }
  it.each([false, true])("uses two lines with read=%s and the correct weight", (read) => {
    const { container } = row(read);
    expect(screen.getByText("buyer@example.test")).toHaveStyle({ fontWeight: read ? "400" : "600" });
    expect(screen.getByText("subject")).toHaveStyle({ fontWeight: read ? "400" : "600" });
    expect(container.querySelector('[data-mail-line="sender"]')).toContainElement(screen.getByText("buyer@example.test"));
    expect(container.querySelector('[data-mail-line="subject"]')).toContainElement(screen.getByText("subject"));
    expect(screen.getByText("— snippet")).toHaveStyle({ color: "var(--color-text-muted)" });
    expect(container.querySelectorAll('[data-mail-line="subject"] > [aria-hidden]')).toHaveLength(read ? 0 : 1);
  });
  it.each(["buyer@example.test", "ari@rebattery.io"])("shows To: %s, never You, for self-sent mail", (email) => {
    const { container } = row(true, { is_self: true, counterparty: { email, name: email } });
    expect(container.querySelector('[data-mail-line="sender"]')).toHaveTextContent(`To: ${email}`);
    expect(screen.queryByText("You")).not.toBeInTheDocument();
    expect(screen.getByText("To:")).toHaveStyle({ fontWeight: "400", color: "var(--color-text-muted)" });
  });
  it("does not substitute a participant for a missing inbound sender", () => {
    row(false, { primary_sender_email: null, participants: [{ id: "recipient", name: "Alex", email: "alex@rebattery.io", avatar_url: null }] });
    expect(screen.getByText("Unknown sender")).toBeInTheDocument();
  });
  it.each(["Person", "person", "self"])("does not show a %s chip", (primary_sender_type) => {
    row(false, { primary_sender_type });
    expect(screen.queryByText(primary_sender_type, { exact: true })).toBeNull();
  });
  it("keeps genuine exception chips and independent selection controls", () => {
    const { onSelect, onToggleSelected, onToggleStarred } = row(false, { primary_sender_type: "Marketing" });
    expect(screen.getByText("Marketing")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByTitle("Star"));
    expect(onToggleSelected).toHaveBeenCalledOnce();
    expect(onToggleStarred).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("subject"));
    expect(onSelect).toHaveBeenCalledOnce();
  });
});
