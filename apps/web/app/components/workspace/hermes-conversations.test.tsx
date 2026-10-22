// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
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
let serverPins: string[];
let sessions: HermesConversation[];
beforeEach(() => {
  localStorage.clear();
  sessions = [group, solo];
  messages = [{ id: "first", role: "user", text: "Existing room history" }];
  created = solo;
  serverPins = [];
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/hermes/pins") {
      if (init?.method === "PUT") {
        const body = JSON.parse(init.body as string);
        serverPins = body.pinned ? [...new Set([...serverPins, body.key])] : serverPins.filter((key) => key !== body.key);
        return Response.json({ ...body, pins: serverPins });
      }
      return Response.json({ pins: serverPins });
    }
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
  it("opens once on touch and keeps selection separate from pinning, focus and hover", async () => {
    const user = userEvent.setup(); render(<Harness />);
    const open = await screen.findByRole("button", { name: "Open Alpha solo" });
    const row = open.closest("[data-conversation-key]")!;
    const avatar = within(row as HTMLElement).getByLabelText("Participants: Alpha");
    const pin = screen.getByRole("button", { name: "Pin Alpha solo" });
    expect(avatar.closest("button")).toBeNull();
    expect(row.className).not.toMatch(/hover:bg|focus-within:bg/);
    expect(avatar.parentElement!.className).not.toMatch(/opacity-0|hover/);
    expect(pin.className).toContain("h-11 w-11");
    fireEvent.mouseEnter(row);
    pin.focus();
    expect(row).toHaveAttribute("data-selected", "false");
    await user.pointer([{ keys: '[TouchA>]', target: open }, { keys: '[/TouchA]' }]);
    expect(open).toHaveAttribute("aria-current", "true");
    expect(row).toHaveAttribute("data-selected", "true");
    const requestCount = fetchMock.mock.calls.length;
    await user.click(pin);
    expect(screen.getByRole("button", { name: "Unpin Alpha solo" })).toHaveAttribute("aria-pressed", "true");
    expect(fetchMock.mock.calls.slice(requestCount).every(([url, init]) => url === "/api/hermes/pins" && init?.method === "PUT")).toBe(true);
    expect(screen.getByRole("button", { name: "Open Alpha solo" })).toHaveAttribute("aria-current", "true");
  });
  it("defaults to all chats, separates presence from working and keeps a selected group routed while the workspace picker filters", async () => {
    const user = userEvent.setup(); render(<Harness />);
    const list = await screen.findByLabelText("Hermes conversations");
    await waitFor(() => expect(within(list).getByText("Alpha solo")).toBeInTheDocument());
    expect(within(list).queryByRole("img", { name: /Running|attention|activity/ })).not.toBeInTheDocument();
    expect(within(list).getByLabelText("Participants: Alpha, Sol").children).toHaveLength(2);
    await user.click(within(list).getByRole("button", { name: /^Open Shared room/ }));
    await waitFor(() => expect(within(list).getByRole("button", { name: /^Open Shared room/ })).toHaveAttribute("aria-current", "true"));
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
    if (created.kind === "group") await waitFor(() => expect(screen.getByRole("button", { name: /^Open Shared room/ })).toHaveAttribute("aria-current", "true"));
    else await waitFor(() => expect(screen.getByRole("button", { name: /^Open Alpha solo/ })).toHaveAttribute("aria-current", "true"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const request = fetchMock.mock.calls.find(([url, init]) => url === "/api/hermes/conversations" && init?.method === "POST");
    expect(JSON.parse(request![1].body)).toEqual({ profiles });
  });
  it("copies the session id from the row menu", async () => {
    const user = userEvent.setup(); render(<Harness />);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await user.click(await screen.findByRole("button", { name: "More options for Alpha solo" }));
    await user.click(await screen.findByRole("menuitem", { name: "Copy ID" }));
    expect(writeText).toHaveBeenCalledWith(solo.id);
  });
  it("renames a chat in place and sends the new title", async () => {
    const user = userEvent.setup(); render(<Harness />);
    await user.click(await screen.findByRole("button", { name: "More options for Alpha solo" })); await user.click(await screen.findByRole("menuitem", { name: /^Rename/ }));
    const input = await screen.findByLabelText("Chat title");
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
    expect(chatStatus({ ...solo, working: false, background: true }, { ...base, seen: {} })).toBe("background");
    expect(chatStatus({ ...solo, working: false }, { ...base, seen: {} }, false, false, true)).toBe("background");
    expect(chatStatus({ ...solo, working: true, background: true }, { ...base, seen: {} })).toBe("running");
    expect(chatStatus({ ...solo, background: true, blocked: true }, { ...base, seen: {} })).toBe("awaiting");
    const user = userEvent.setup(); render(<Harness />);
    const list = await screen.findByLabelText("Hermes conversations");
    await waitFor(() => expect(within(list).getByText("Alpha solo")).toBeInTheDocument());
    expect(within(list).queryByRole("img", { name: /Running|attention|activity/ })).not.toBeInTheDocument();
    expect(list.textContent).not.toMatch(/Idle|unavailable|Working/);
    await user.click(screen.getByRole("button", { name: "new group" })); // dialog opens without hiding the list
    expect(within(list).getByText("Alpha solo")).toBeInTheDocument();
  });
  it("keeps automation collapsed, discoverable and read-only", async () => {
    sessions = [solo, { ...solo, key: "cron", title: "Daily digest", source: "cron" }];
    const user = userEvent.setup(); render(<Harness />);
    await screen.findByText("Alpha solo");
    expect(screen.getByRole("button", { name: "Automation 1" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Daily digest")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Automation 1" }));
    expect(screen.getByRole("button", { name: "Open Daily digest" })).toHaveTextContent("read-only");
    await user.click(screen.getByRole("button", { name: "Open Daily digest" }));
    expect(fetchMock.mock.calls.every(([url, init]) => !init?.method || url === "/api/hermes/pins")).toBe(true);
  });
  it("pins via keyboard and touch without selecting, persists collapse and unpins to source", async () => {
    const user = userEvent.setup(); const first = render(<Harness />);
    (await screen.findByRole("button", { name: "Pin Alpha solo" })).focus(); await user.keyboard("{Enter}");
    expect(screen.getByRole("button", { name: "Open Alpha solo" })).not.toHaveAttribute("aria-current");
    expect(within(screen.getByRole("region", { name: "Pinned" })).getByText("Alpha solo")).toBeInTheDocument();
    expect(screen.getAllByText("Alpha solo")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Pinned 1" }));
    first.unmount(); render(<Harness />);
    await screen.findByRole("button", { name: "Pinned 1" });
    expect(screen.getByRole("button", { name: "Pinned 1" })).toHaveAttribute("aria-expanded", "false");
    await user.click(screen.getByRole("button", { name: "Pinned 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Unpin Alpha solo" }));
    expect(within(screen.getByRole("region", { name: "Chats" })).getByText("Alpha solo")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Pinned" })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.every(([url, init]) => !init?.method || url === "/api/hermes/pins")).toBe(true);
  });
  it("persists project sorting without rerouting and keeps hidden sources in the filter without notice copy", async () => {
    localStorage.setItem("hermes-chats-view", JSON.stringify({ ...DEFAULT_VIEW, hidden: ["webhook", "cron"] }));
    sessions = [{ ...solo, key: "unknown", title: "Recent chat", updatedAt: 900 }, { ...solo, key: "project", title: "Project chat", project: "Beacon" }];
    const user = userEvent.setup(); const first = render(<Harness />);
    await user.click(await screen.findByRole("button", { name: "Open Recent chat" }));
    expect(screen.queryByText(/Webhook and Scheduled hidden|Scheduled and Webhook hidden/)).not.toBeInTheDocument();
    screen.getByRole("button", { name: "Filter and group chats" }).focus(); await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitemcheckbox", { name: "Webhook 0" })).toHaveAttribute("aria-checked", "false");
    await user.click(screen.getByRole("menuitemradio", { name: /^Project$/ })); await user.keyboard("{Escape}");
    expect(screen.getAllByRole("button", { name: /^Open / }).map((button) => button.getAttribute("aria-label"))).toEqual(["Open Project chat", "Open Recent chat"]);
    expect(screen.getByRole("button", { name: "Open Recent chat" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: "Open Recent chat" })).toHaveTextContent("No project");
    expect(JSON.parse(localStorage.getItem("hermes-chats-view")!)).toMatchObject({ sortBy: "project", hidden: ["webhook", "cron"] });
    first.unmount(); render(<Harness />);
    expect(await screen.findByRole("button", { name: "Open Project chat" })).toHaveTextContent("Beacon");
    screen.getByRole("button", { name: "Filter and group chats" }).focus(); await user.keyboard("{ArrowDown}");
    await user.click(screen.getByRole("menuitemradio", { name: "Most recent" })); await user.keyboard("{Escape}");
    expect(screen.getAllByRole("button", { name: /^Open / }).map((button) => button.getAttribute("aria-label"))).toEqual(["Open Recent chat", "Open Project chat"]);
  });
  it("adds the flowing border only for confirmed running rows, never unknown, idle, unread or blocked", async () => {
    sessions = [
      { ...solo, key: "running", title: "Running chat", working: true },
      { ...solo, key: "blocked", title: "Blocked chat", working: true, blocked: true },
      { ...solo, key: "unknown", title: "Unknown chat", working: null },
      { ...solo, key: "idle", title: "Idle chat", working: false },
      { ...solo, key: "unread", title: "Unread chat", working: false, updatedAt: 500 },
      { ...solo, key: "background", title: "Background chat", working: false, background: true },
    ];
    localStorage.setItem("hermes-chats-seen", JSON.stringify({ unread: 100 }));
    render(<Harness />);
    await screen.findByRole("button", { name: "Open Running chat" });
    for (const [name, status] of [["Running", "running"], ["Blocked", "awaiting"], ["Unknown", "idle"], ["Idle", "idle"], ["Unread", "done"], ["Background", "background"]]) {
      const row = screen.getByRole("button", { name: `Open ${name} chat` }).closest("[data-conversation-key]")!;
      expect(row).toHaveAttribute("data-status", status);
      expect(row.className.includes("running")).toBe(status === "running");
    }
  });
  it("migrates explicit hidden choices and keeps searched zero-count sources toggleable", async () => {
    localStorage.setItem("hermes-chats-view", JSON.stringify({ hidden: ["discord", "cron", "webhook"], groupBy: "none" }));
    sessions = [solo, { ...group, source: "discord", kind: "solo", title: "Hidden channel" }];
    const user = userEvent.setup(); render(<Harness />);
    await screen.findByText("Alpha solo");
    expect(screen.queryByText("Hidden channel")).not.toBeInTheDocument();
    await user.type(screen.getByRole("searchbox"), "missing");
    screen.getByRole("button", { name: "Filter and group chats" }).focus(); await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitemcheckbox", { name: "Discord 0" })).toHaveAttribute("aria-checked", "false");
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Discord 0" }));
    expect(JSON.parse(localStorage.getItem("hermes-chats-view")!)).toMatchObject({ version: 2, hidden: ["cron", "webhook"], groupBy: "source" });
  });
  it.each(["Channel", "Agent", "Day", "Scheduled job"])("keeps pins unique in secondary %s view", async (label) => {
    const user = userEvent.setup(); render(<Harness />);
    await user.click(await screen.findByRole("button", { name: "Pin Alpha solo" }));
    screen.getByRole("button", { name: "Filter and group chats" }).focus(); await user.keyboard("{ArrowDown}");
    await user.click(screen.getByRole("menuitemradio", { name: label })); await user.keyboard("{Escape}");
    expect(within(screen.getByRole("region", { name: "Pinned" })).getByText("Alpha solo")).toBeInTheDocument();
    expect(screen.getAllByText("Alpha solo")).toHaveLength(1);
  });
  it("keeps selected composite identity through profile filters and refresh", async () => {
    const { result } = renderHook(() => useHermesConversations());
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => result.current.select(group)); act(() => result.current.setFilter("other"));
    await act(() => result.current.reload());
    expect(result.current.selected?.key).toBe(group.key);
    const restored = renderHook(() => useHermesConversations());
    await waitFor(() => expect(restored.result.current.filter).toBe("other"));
  });
  it("uses local messaging aliases consistently in search, selection and reload", async () => {
    sessions = [{ ...solo, source: "whatsapp" }];
    const user = userEvent.setup(); const first = render(<Harness />);
    await user.click(await screen.findByRole("button", { name: "More options for Alpha solo" })); await user.click(await screen.findByRole("menuitem", { name: /^Rename/ }));
    const titleInput = await screen.findByLabelText("Chat title"); await user.clear(titleInput); await user.type(titleInput, "Harbour contact{Enter}");
    await user.click(await screen.findByRole("button", { name: "Open Harbour contact" }));
    expect(screen.getByRole("button", { name: "Open Harbour contact" })).toHaveAttribute("aria-current", "true");
    await user.type(screen.getByRole("searchbox"), "harbour"); expect(screen.getByText("Harbour contact")).toBeInTheDocument();
    first.unmount(); render(<Harness />); await screen.findByText("Harbour contact");
    expect(fetchMock.mock.calls.every(([url, init]) => !init?.method || url === "/api/hermes/pins")).toBe(true);
  });
  it("recovers from initial loading and failure without showing a false empty state", async () => {
    let reject!: (error: Error) => void;
    fetchMock.mockImplementationOnce(() => new Promise((_resolve, no) => { reject = no; }));
    const user = userEvent.setup(); render(<Harness />);
    expect(screen.getByRole("status", { name: "Loading chats" })).toBeInTheDocument();
    expect(screen.queryByText("No conversations yet.")).not.toBeInTheDocument();
    await act(async () => reject(new Error("Synthetic offline")));
    expect(await screen.findByRole("alert")).toHaveTextContent("Synthetic offline");
    await user.click(screen.getByRole("button", { name: "Retry loading chats" })); await screen.findByText("Alpha solo");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("works with malformed/unavailable storage and clears an empty search", async () => {
    localStorage.setItem("hermes-chats-view", '{"hidden":"bad","groupBy":"invalid"}');
    const user = userEvent.setup(); render(<Harness />); await screen.findByText("Alpha solo");
    const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    try {
      await user.click(screen.getByRole("button", { name: "Pin Alpha solo" }));
      await user.type(screen.getByRole("searchbox"), "missing");
      expect(screen.getByText("No conversations match this view.")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Clear search and source filters" })); expect(screen.getByText("Alpha solo")).toBeInTheDocument();
    } finally { storage.mockRestore(); }
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
    const result = applyChatView([{ ...solo, source: "cron" }, { ...solo, key: "other", source: "discord", title: "Unmatched", participants: [{ profile: "beta", name: "Beta" }] }], { hidden: ["cron", "webhook"], groupBy: "source" }, " alpha ");
    expect(result).toMatchObject({ sections: [], shown: 0, hiddenCount: 1 });
    expect(result.channels).toEqual([{ id: "cron", label: "Scheduled", count: 1 }, { id: "webhook", label: "Webhook", count: 0 }]);
  });
});

describe("useHermesConversations loading and deep links", () => {
  it("is not ready until the first listing settles, even when the backend is not Hermes", async () => {
    fetchMock.mockImplementation(async () => Response.json({ backend: "legacy" }));
    const { result } = renderHook(() => useHermesConversations());
    expect(result.current).toMatchObject({ ready: false, enabled: false });
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.enabled).toBe(false);
  });

  it("opens a conversation missing from the listing and reports one that cannot be loaded", async () => {
    const { result } = renderHook(() => useHermesConversations());
    await waitFor(() => expect(result.current.ready).toBe(true));
    const detail = { ...solo, key: "older", title: "Older chat" };
    fetchMock.mockImplementation(async (url: string) => url.endsWith("/missing")
      ? Response.json({ error: "Could not load Hermes conversation" }, { status: 502 })
      : Response.json({ conversation: detail, messages: [] }));
    let opened = false;
    await act(async () => { opened = await result.current.selectKey("older"); });
    expect(opened).toBe(true);
    expect(result.current.selected?.title).toBe("Older chat");
    await act(async () => { opened = await result.current.selectKey("missing"); });
    expect(opened).toBe(false);
    expect(result.current.selected?.title).toBe("Older chat");
  });
});

describe("server-backed pins", () => {
  it("shows pins stored on the server for this user and writes pin changes through the API", async () => {
    serverPins = [solo.key];
    render(<Harness2 />);
    expect(within(await screen.findByRole("region", { name: "Pinned" })).getByText("Alpha solo")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pin Shared room" }));
    await waitFor(() => expect(serverPins).toEqual([solo.key, group.key]));
    fireEvent.click(screen.getByRole("button", { name: "Unpin Alpha solo" }));
    await waitFor(() => expect(serverPins).toEqual([group.key]));
  });
  it("migrates browser-local pins to the server once and clears them locally", async () => {
    localStorage.setItem("hermes-chats-view", JSON.stringify({ ...DEFAULT_VIEW, pins: [solo.key] }));
    render(<Harness2 />);
    await waitFor(() => expect(serverPins).toEqual([solo.key]));
    await waitFor(() => expect(JSON.parse(localStorage.getItem("hermes-chats-view")!).pins).toEqual([]));
  });
  it("rolls back and reports a failed pin", async () => {
    const base = fetchMock.getMockImplementation() as (url: string, init?: RequestInit) => Promise<Response>;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => url === "/api/hermes/pins" && init?.method === "PUT" ? Response.json({ error: "chat_not_found" }, { status: 404 }) : base(url, init));
    render(<Harness2 />);
    fireEvent.click(await screen.findByRole("button", { name: "Pin Alpha solo" }));
    await screen.findByText("That chat no longer exists").catch(() => undefined);
    await waitFor(() => expect(screen.getByRole("button", { name: "Pin Alpha solo" })).toBeInTheDocument());
  });
});
function Harness2() { const chats = useHermesConversations(); return <HermesConversationList chats={chats} />; }
