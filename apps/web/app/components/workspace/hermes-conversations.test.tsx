// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applyChatView, automation, conversationChannel, DEFAULT_VIEW, conversationKey, type HermesConversation } from "@/lib/hermes-conversations";
import { chatStatus, HermesConversationList, HermesNewChatDialog, useHermesConversations } from "./hermes-conversations";
import { ProfileSwitcher } from "./profile-switcher";
vi.mock("./profile-avatar", () => ({ ProfileAvatar: ({ name }: { name: string }) => <span data-testid={`avatar-${name}`} /> }));
const solo: HermesConversation = { key: conversationKey("solo", "same-id", "alpha"), id: "same-id", kind: "solo", profile: "alpha", title: "Alpha solo", participants: [{ profile: "alpha", name: "Alpha" }], updatedAt: 100, working: null };
const group: HermesConversation = { key: conversationKey("group", "native-room"), id: "native-room", kind: "group", title: "Shared room", participants: [{ profile: "alpha", name: "Alpha", memberId: "a" }, { profile: "default", name: "Sol", memberId: "b" }], updatedAt: 200, working: false };
function Harness() {
  const chats = useHermesConversations();
  return <><ProfileSwitcher conversationFilter={{ value: chats.filter, profiles: chats.listing?.profiles ?? [], onChange: chats.setFilter }} /><button type="button" onClick={() => chats.newChat("solo")}>new solo</button><button type="button" onClick={() => chats.newChat("group")}>new group</button><HermesConversationList chats={chats} /><HermesNewChatDialog chats={chats} /></>;
}
let messages: { id: string; role: string; text: string }[];
let created: HermesConversation;
let fetchMock: ReturnType<typeof vi.fn>;
let sessions: HermesConversation[];
beforeEach(() => {
  localStorage.clear();
  sessions = [group, solo];
  messages = [{ id: "first", role: "user", text: "Existing room history" }];
  created = solo;
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/hermes/conversations") {
      if (init?.method === "POST") return Response.json({ conversation: created });
      return Response.json({ backend: "hermes", profiles: ["default", "alpha", "other"], sessions, warnings: [], groupsAvailable: true });
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
    await waitFor(() => expect(within(list).getByRole("button", { name: /^(?!Rename).*Shared room/ })).toHaveAttribute("aria-current", "true"));
    await user.click(screen.getByTitle("Switch workspace"));
    await user.click(screen.getByText("other"));
    await waitFor(() => expect(within(list).queryByText("Shared room")).not.toBeInTheDocument());
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
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
    if (created.kind === "group") await waitFor(() => expect(screen.getByRole("button", { name: /^(?!Rename).*Shared room/ })).toHaveAttribute("aria-current", "true"));
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
    const base = { selected: null };
    expect(chatStatus({ ...solo, working: true }, { ...base, seen: {} })).toBe("running");
    expect(chatStatus({ ...group, blocked: true }, { ...base, seen: {} })).toBe("awaiting");
    expect(chatStatus({ ...solo, working: true }, { ...base, seen: {} }, true, true)).toBe("awaiting");
    expect(chatStatus({ ...group, working: true, blocked: true }, { ...base, seen: {} }, true)).toBe("awaiting");
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
  it("hides automation by default, counts hidden channels and toggles them in the menu", async () => {
    sessions = [
      { ...solo, source: "discord" },
      { ...solo, key: "cron", title: "Daily digest · 09:00", source: "cron" },
      { ...solo, key: "hook", title: "Incoming webhook", source: "webhook" },
    ];
    const user = userEvent.setup(); render(<Harness />);
    await screen.findByText("Alpha solo");
    expect(screen.queryByText("Daily digest · 09:00")).not.toBeInTheDocument();
    expect(screen.queryByText("Incoming webhook")).not.toBeInTheDocument();
    screen.getByRole("button", { name: "Chat view" }).focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitemcheckbox", { name: "Scheduled 1" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("menuitemcheckbox", { name: "Webhook 1" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("menuitemcheckbox", { name: "Discord 1" })).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Scheduled 1" }));
    await user.keyboard("{Escape}");
    expect(screen.getByText("Daily digest · 09:00")).toBeInTheDocument();
    expect(screen.getByText("read-only")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Webhook hidden" }));
    expect(screen.getByText("Incoming webhook")).toBeInTheDocument();
  });
  it.each([
    ["Channel", ["Scheduled", "Discord"]],
    ["Day", ["Today", "Yesterday"]],
    ["Scheduled job", ["Digest", "Discord"]],
  ])("groups chats by %s into sections", async (label, headings) => {
    const now = new Date();
    sessions = [
      { ...solo, key: "cron", title: "Digest · 09:00", source: "cron", updatedAt: now.getTime() },
      { ...solo, key: "discord", title: "Channel chat", source: "discord", updatedAt: new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12).getTime() },
    ];
    const user = userEvent.setup(); render(<Harness />);
    await screen.findByText("Channel chat");
    await user.click(screen.getByRole("button", { name: "Scheduled and Webhook hidden" }));
    screen.getByRole("button", { name: "Chat view" }).focus();
    await user.keyboard("{ArrowDown}");
    await user.click(screen.getByRole("menuitemradio", { name: label }));
    await user.keyboard("{Escape}");
    for (const heading of headings) expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
  });
  it("searches titles and participants and persists only channel and grouping preferences", async () => {
    sessions = [{ ...solo, source: "crm" }, { ...solo, key: "hook", title: "Delivery", source: "webhook", participants: [{ profile: "beta", name: "Beatrice" }] }];
    const user = userEvent.setup();
    const first = render(<Harness />);
    await screen.findByText("Alpha solo");
    await user.click(screen.getByRole("button", { name: "Scheduled and Webhook hidden" }));
    screen.getByRole("button", { name: "Chat view" }).focus();
    await user.keyboard("{ArrowDown}");
    await user.click(screen.getByRole("menuitemradio", { name: "Channel" }));
    await user.keyboard("{Escape}");
    await user.type(screen.getByRole("searchbox", { name: "Search chats" }), "beat");
    expect(screen.getByText("Delivery")).toBeInTheDocument();
    expect(screen.queryByText("Alpha solo")).not.toBeInTheDocument();
    await user.clear(screen.getByRole("searchbox", { name: "Search chats" }));
    await user.type(screen.getByRole("searchbox", { name: "Search chats" }), "alpha solo");
    expect(screen.queryByText("Delivery")).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("hermes-chats-view")!)).toEqual({ hidden: [], groupBy: "channel" });
    first.unmount();
    render(<Harness />);
    await screen.findByText("Delivery");
    expect(screen.getByRole("searchbox", { name: "Search chats" })).toHaveValue("");
    expect(screen.getByRole("heading", { name: "Webhook" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "CRM" })).toBeInTheDocument();
  });
  it("keeps hidden zero-count channels toggleable after search and rejects invalid saved views", async () => {
    localStorage.setItem("hermes-chats-view", '{"hidden":"cron","groupBy":"invalid"}');
    const user = userEvent.setup(); render(<Harness />);
    await screen.findByText("Alpha solo");
    await user.type(screen.getByRole("searchbox", { name: "Search chats" }), "missing");
    screen.getByRole("button", { name: "Chat view" }).focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitemcheckbox", { name: "Scheduled 0" })).toHaveAttribute("aria-checked", "false");
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Scheduled 0" }));
    expect(JSON.parse(localStorage.getItem("hermes-chats-view")!).hidden).toEqual(["webhook"]);
  });
});
describe("chat view edge cases", () => {
  it("uses local midnight boundaries and preserves source labels and automation semantics", () => {
    const now = new Date(2026, 9, 16, 0, 0, 1);
    const midnight = new Date(2026, 9, 16).getTime();
    const rows = [0, -1, -86_400_000, -7 * 86_400_000, -30 * 86_400_000].map((offset, index) => ({ ...solo, key: `${index}`, updatedAt: midnight + offset }));
    const result = applyChatView(rows, { hidden: [], groupBy: "day" }, "", now);
    expect(result.sections.map((section) => [section.label, section.rows.map((row) => row.key)])).toEqual([
      ["Today", ["0"]], ["Yesterday", ["1", "2"]], ["Last 7 days", ["3"]], ["Last 30 days", ["4"]],
    ]);
    expect(conversationChannel({ ...solo, source: "crm" })).toEqual({ id: "crm", label: "CRM" });
    expect(automation({ ...solo, source: "cron" })).toBe(true);
    expect(automation({ ...solo, source: "webhook" })).toBe(true);
    expect(automation({ ...group, source: "cron" })).toBe(false);
  });
  it("counts matching hidden channels before hiding and retains absent hidden channels", () => {
    const result = applyChatView([{ ...solo, source: "cron" }, { ...solo, key: "other", source: "discord", title: "Unmatched", participants: [{ profile: "beta", name: "Beta" }] }], DEFAULT_VIEW, " alpha ");
    expect(result).toMatchObject({ sections: [], shown: 0, hiddenCount: 1 });
    expect(result.channels).toEqual([{ id: "cron", label: "Scheduled", count: 1 }, { id: "webhook", label: "Webhook", count: 0 }]);
  });
});
