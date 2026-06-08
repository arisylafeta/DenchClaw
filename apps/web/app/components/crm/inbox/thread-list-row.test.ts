import { describe, expect, it } from "vitest";
import type { Thread } from "./types";
import { pickSenderDisplay } from "./thread-list-row";

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
  it("shows recipient when latest sender is ReBattery", () => {
    const thread = makeThread({
      primary_sender_id: "p_rebattery",
      primary_sender_name: "Alex",
      primary_sender_email: "alex@rebattery.io",
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
