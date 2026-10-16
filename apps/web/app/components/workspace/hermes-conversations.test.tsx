// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { conversationKey, type HermesConversation } from "@/lib/hermes-conversations";
import { HermesConversationList, HermesConversationPanel, useHermesConversations } from "./hermes-conversations";
import { ProfileSwitcher } from "./profile-switcher";
vi.mock("./profile-avatar", () => ({ ProfileAvatar: ({ name }: { name: string }) => <span data-testid={`avatar-${name}`} /> }));
const solo: HermesConversation = { key: conversationKey("solo", "same-id", "alpha"), id: "same-id", kind: "solo", profile: "alpha", title: "Alpha solo", participants: [{ profile: "alpha", name: "Alpha" }], updatedAt: 100, working: null };
const group: HermesConversation = { key: conversationKey("group", "native-room"), id: "native-room", kind: "group", title: "Shared room", participants: [{ profile: "alpha", name: "Alpha", memberId: "a" }, { profile: "default", name: "Sol", memberId: "b" }], updatedAt: 200, working: false };
function Harness() {
  const chats = useHermesConversations();
  return <><ProfileSwitcher conversationFilter={{ value: chats.filter, profiles: chats.listing?.profiles ?? [], onChange: chats.setFilter }} /><HermesConversationList chats={chats} /><HermesConversationPanel chats={chats} /></>;
}
let messages: { id: string; role: string; text: string }[];
let created: HermesConversation;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  messages = [{ id: "first", role: "user", text: "Existing room history" }];
  created = solo;
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/hermes/conversations") {
      if (init?.method === "POST") return Response.json({ conversation: created });
      return Response.json({ backend: "hermes", profiles: ["default", "alpha", "other"], sessions: [group, solo], warnings: [], groupsAvailable: true });
    }
    const identity = url.includes(encodeURIComponent(group.key)) ? group : solo;
    if (init?.method === "POST") {
      const body = JSON.parse(init.body as string);
      messages = [...messages, { id: body.eventId, role: "user", text: body.message }];
      if (identity.kind === "solo") {
        const frames = 'event: assistant.delta\ndata: {"delta":"Native continuation"}\n\nevent: run.completed\ndata: {}\n\n';
        messages.push({ id: "response", role: "assistant", text: "Native continuation" });
        return new Response(frames, { headers: { "Content-Type": "text/event-stream" } });
      }
    }
    return Response.json({ conversation: identity, messages });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());
describe("Hermes unified chat UI", () => {
  it("defaults to all chats, separates presence from working and keeps a selected group routed while the workspace picker filters", async () => {
    const user = userEvent.setup(); render(<Harness />);
    const list = await screen.findByLabelText("Hermes conversations");
    await waitFor(() => expect(within(list).getByText("Alpha solo")).toBeInTheDocument());
    expect(within(list).getByText("Group · Idle")).toBeInTheDocument();
    expect(within(list).queryByLabelText("Working")).not.toBeInTheDocument();
    expect(within(list).getByLabelText("Participants: Alpha, Sol").children).toHaveLength(2);
    await user.click(within(list).getByRole("button", { name: /Shared room/ }));
    await screen.findByText("Existing room history");
    await user.click(screen.getByTitle("Switch workspace"));
    await user.click(screen.getByText("other"));
    await waitFor(() => expect(within(list).queryByText("Shared room")).not.toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "Shared room" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Message"), "Continue existing group");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText("Continue existing group");
    const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0][0]).toBe(`/api/hermes/conversations/${encodeURIComponent(group.key)}`);
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/workspace/switch")).toBe(false);
    await user.click(screen.getByTitle("Switch workspace"));
    await user.click(screen.getByRole("button", { name: "All chats" }));
    await waitFor(() => expect(within(list).getByText("Shared room")).toBeInTheDocument());
  });
  it.each([["alpha"], ["default", "alpha"]])("creates a chat with the chosen bots %j", async (...profiles: string[]) => {
    // Vitest spreads array cases; retain exactly the selected roster.
    created = profiles.length === 1 ? solo : group;
    const user = userEvent.setup(); render(<Harness />);
    await screen.findByText("Choose one bot for a solo chat, or two to six for a group");
    await waitFor(() => expect(screen.getAllByRole("checkbox")).toHaveLength(3));
    for (const profile of profiles) await user.click(screen.getByRole("checkbox", { name: profile }));
    await user.click(screen.getByRole("button", { name: profiles.length > 1 ? "Create group chat" : "Create solo chat" }));
    if (created.kind === "group") await screen.findByRole("heading", { name: created.title });
    else await waitFor(() => expect(screen.getByRole("button", { name: /Alpha solo/ })).toHaveAttribute("aria-current", "true"));
    const request = fetchMock.mock.calls.find(([url, init]) => url === "/api/hermes/conversations" && init?.method === "POST");
    expect(JSON.parse(request![1].body)).toEqual({ profiles });
  });
  it("delegates selected solo chats instead of rendering a second solo client", async () => {
    const user = userEvent.setup(); render(<Harness />);
    await user.click(await screen.findByRole("button", { name: /Alpha solo/ }));
    expect(screen.queryByLabelText("Message")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Hermes chat")).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => url.includes(encodeURIComponent(solo.key)))).toBe(false);
  });
});
