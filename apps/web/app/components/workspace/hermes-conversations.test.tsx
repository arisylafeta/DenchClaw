// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { conversationKey, type HermesConversation } from "@/lib/hermes-conversations";
import { chatStatus, HermesConversationList, HermesConversationPanel, HermesNewChatDialog, useHermesConversations } from "./hermes-conversations";
import { ProfileSwitcher } from "./profile-switcher";
vi.mock("./profile-avatar", () => ({ ProfileAvatar: ({ name }: { name: string }) => <span data-testid={`avatar-${name}`} /> }));
const solo: HermesConversation = { key: conversationKey("solo", "same-id", "alpha"), id: "same-id", kind: "solo", profile: "alpha", title: "Alpha solo", participants: [{ profile: "alpha", name: "Alpha" }], updatedAt: 100, working: null };
const group: HermesConversation = { key: conversationKey("group", "native-room"), id: "native-room", kind: "group", title: "Shared room", participants: [{ profile: "alpha", name: "Alpha", memberId: "a" }, { profile: "default", name: "Sol", memberId: "b" }], updatedAt: 200, working: false };
function Harness() {
  const chats = useHermesConversations();
  return <><ProfileSwitcher conversationFilter={{ value: chats.filter, profiles: chats.listing?.profiles ?? [], onChange: chats.setFilter }} /><button type="button" onClick={() => chats.newChat("solo")}>new solo</button><button type="button" onClick={() => chats.newChat("group")}>new group</button><HermesConversationList chats={chats} /><HermesConversationPanel chats={chats} /><HermesNewChatDialog chats={chats} /></>;
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
    expect(within(list).queryByRole("img", { name: /Running|attention|activity/ })).not.toBeInTheDocument();
    expect(within(list).getByLabelText("Participants: Alpha, Sol").children).toHaveLength(2);
    await user.click(within(list).getByRole("button", { name: /^(?!Rename).*Shared room/ }));
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
  it.each([["solo", ["alpha"]], ["group", ["default", "alpha"]]] as const)("creates a %s chat from the dialog with the chosen agents", async (mode, profiles) => {
    created = mode === "solo" ? solo : group;
    const user = userEvent.setup(); render(<Harness />);
    await waitFor(() => expect(screen.getByRole("button", { name: `new ${mode}` })).toBeInTheDocument());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: `new ${mode}` }));
    const dialog = await screen.findByRole("dialog", { name: "New chat" });
    for (const profile of profiles) await user.click(within(dialog).getByRole(mode === "solo" ? "radio" : "checkbox", { name: profile }));
    await user.click(within(dialog).getByRole("button", { name: "Start chat" }));
    if (created.kind === "group") await screen.findByRole("heading", { name: created.title });
    else await waitFor(() => expect(screen.getByRole("button", { name: /^(?!Rename).*Alpha solo/ })).toHaveAttribute("aria-current", "true"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const request = fetchMock.mock.calls.find(([url, init]) => url === "/api/hermes/conversations" && init?.method === "POST");
    expect(JSON.parse(request![1].body)).toEqual({ profiles });
  });
  it("renames a chat in place and sends the new title", async () => {
    const user = userEvent.setup(); render(<Harness />);
    await user.click(await screen.findByRole("button", { name: "Rename Alpha solo" }));
    const input = screen.getByLabelText("Chat title");
    await user.clear(input); await user.type(input, "Renamed chat{Enter}");
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true));
    const request = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH")!;
    expect(request[0]).toBe(`/api/hermes/conversations/${encodeURIComponent(solo.key)}`);
    expect(JSON.parse(request[1].body)).toEqual({ title: "Renamed chat" });
  });
  it("shows a dot only for running, awaiting and unread chats, never status text", async () => {
    const base = { busy: new Set<string>(), selected: null };
    expect(chatStatus({ ...solo, working: true }, { ...base, seen: {} })).toBe("running");
    expect(chatStatus({ ...group, blocked: true }, { ...base, seen: {} })).toBe("awaiting");
    expect(chatStatus({ ...solo, updatedAt: 500 }, { ...base, seen: { [solo.key]: 100 } })).toBe("done");
    expect(chatStatus({ ...solo, updatedAt: 500 }, { ...base, selected: solo, seen: { [solo.key]: 100 } })).toBe("idle");
    expect(chatStatus({ ...solo, working: null }, { ...base, seen: {} })).toBe("idle");
    const user = userEvent.setup(); render(<Harness />);
    const list = await screen.findByLabelText("Hermes conversations");
    await waitFor(() => expect(within(list).getByText("Alpha solo")).toBeInTheDocument());
    expect(within(list).queryByRole("img", { name: /Running|attention|activity/ })).not.toBeInTheDocument();
    expect(list.textContent).not.toMatch(/Idle|unavailable|Working/);
    await user.click(screen.getByRole("button", { name: "new group" })); // dialog opens without hiding the list
    expect(within(list).getByText("Alpha solo")).toBeInTheDocument();
  });
  it("delegates selected solo chats instead of rendering a second solo client", async () => {
    const user = userEvent.setup(); render(<Harness />);
    await user.click(await screen.findByRole("button", { name: /^(?!Rename).*Alpha solo/ }));
    expect(screen.queryByLabelText("Message")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Hermes chat")).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => url.includes(encodeURIComponent(solo.key)))).toBe(false);
  });
});
