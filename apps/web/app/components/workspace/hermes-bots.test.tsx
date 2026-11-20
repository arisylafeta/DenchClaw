// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { conversationKey, type HermesConversation } from "@/lib/hermes-conversations";
import { botConfig, botEntries, botName, mainSession } from "@/lib/hermes-bots";
import { HermesConversationList, HermesNewChatDialog, useHermesConversations } from "./hermes-conversations";
vi.mock("./profile-avatar", () => ({ ProfileAvatar: ({ name, working }: { name: string; working?: boolean }) => <span data-testid={`avatar-${name}`} data-working={working || undefined} /> }));

const mine = { visibility: "private" as const, ownerId: "user-a", canShare: true, canDelete: true, canWrite: true, canApprove: true };
const team = { ...mine, visibility: "team" as const, ownerId: "user-b", canShare: false, canDelete: false };
const chat = (profile: string, id: string, updatedAt: number, extra: Partial<HermesConversation> = {}): HermesConversation =>
  ({ access: mine, key: conversationKey("solo", id, profile), id, kind: "solo", profile, title: `${profile} ${id}`, participants: [{ profile, name: profile }], updatedAt, working: false, source: "crm", ...extra });
const main = chat("sorcerer", "main", 300);
const older = chat("sorcerer", "older", 100);
const cron = chat("sorcerer", "cron-run", 900, { source: "cron", access: team });
const othersPrivate = chat("sorcerer", "theirs", 950, { access: { ...mine, ownerId: "user-b" } });
const alpha = chat("alpha", "a1", 200);

let sessions: HermesConversation[];
let created: HermesConversation;
let fetchMock: ReturnType<typeof vi.fn>;
function Harness() {
  const chats = useHermesConversations();
  return <><button type="button" onClick={() => chats.newChat("solo")}>new solo</button><HermesConversationList chats={chats} /><HermesNewChatDialog chats={chats} /></>;
}
beforeEach(() => {
  localStorage.clear();
  sessions = [main, older, cron, alpha];
  created = chat("papajules", "fresh", 1000);
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/hermes/pins") return Response.json({ pins: [alpha.key] });
    if (url === "/api/hermes/conversations") {
      if (init?.method === "POST") return Response.json({ conversation: created });
      return Response.json({ userId: "user-a", backend: "hermes", profiles: ["alpha", "papajules", "sorcerer"], sessions, warnings: [], groupsAvailable: true });
    }
    return Response.json({ conversation: main, messages: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("bot config and main session", () => {
  it("makes sorcerer and papajules single bots and everything else multi", () => {
    expect(botConfig("sorcerer").mode).toBe("single");
    expect(botConfig("papajules").mode).toBe("single");
    expect(botConfig("devon").mode).toBe("multi");
  });
  it("picks the user's newest ordinary chat, never scheduled runs or another user's private chat", () => {
    expect(mainSession([main, older, cron, othersPrivate], "sorcerer", "user-a")?.key).toBe(main.key);
    expect(mainSession([cron], "sorcerer", "user-a")).toBeNull();
    expect(mainSession([alpha], "alpha", "user-a")).toBeNull();
  });
  it("shows display names while keeping the profile id", () => {
    expect(botName("sorcerer")).toBe("Sourcing Requests");
    expect(botName("papajules")).toBe("Jules Watcher");
    expect(botName("recyclops")).toBe("Recycling Requests");
    expect(botName("devon")).toBe("devon");
  });
  it("lists only single bots", () => {
    expect(botEntries(["alpha", "sorcerer", "papajules"], [main], "user-a").map((entry) => entry.profile)).toEqual(["papajules", "sorcerer"]);
  });
});

describe("Bots section", () => {
  it("sits right under Pinned and keeps the main session off My chats", async () => {
    render(<Harness />);
    await screen.findByRole("button", { name: "Open Sourcing Requests" });
    const order = [...document.querySelectorAll("[data-section]")].map((node) => node.getAttribute("data-section"));
    expect(order.slice(0, 3)).toEqual(["pinned", "bots", "mine"]);
    expect(screen.queryByRole("button", { name: `Open ${main.title}` })).toBeNull();
    expect(screen.getByRole("button", { name: `Open ${older.title}` })).toBeInTheDocument();
  });
  it("continues a single bot's main session without creating a chat", async () => {
    const user = userEvent.setup(); render(<Harness />);
    await user.click(await screen.findByRole("button", { name: "Open Sourcing Requests" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Open Sourcing Requests" })).toHaveAttribute("aria-current", "true"));
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });
  it("creates a single bot's main session on first open and leaves multi bots out of Bots", async () => {
    const user = userEvent.setup(); render(<Harness />);
    await user.click(await screen.findByRole("button", { name: "Open Jules Watcher" }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1));
    expect(screen.queryByRole("button", { name: "New chat with alpha" })).toBeNull();
    expect([...document.querySelectorAll("[data-bot]")].map((row) => row.getAttribute("data-bot")).sort()).toEqual(["papajules", "sorcerer"]);
  });
  it("opens the main session when a single bot is picked in the new chat dialog", async () => {
    const user = userEvent.setup(); render(<Harness />);
    await screen.findByRole("button", { name: "Open Sourcing Requests" });
    await user.click(screen.getByText("new solo"));
    const dialog = screen.getByRole("dialog", { name: "New chat" });
    await user.click(within(dialog).getByText("Sourcing Requests"));
    await user.click(within(dialog).getByRole("button", { name: "Start chat" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Open Sourcing Requests" })).toHaveAttribute("aria-current", "true"));
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });
});

describe("section heights", () => {
  it("gives My chats the remaining height and lets the user resize the others, persisting per user", async () => {
    render(<Harness />);
    await screen.findByRole("button", { name: "Open Sourcing Requests" });
    expect((document.querySelector('[data-section="mine"]') as HTMLElement).style.flex).toBe("1 1 0px");
    const bots = document.querySelector('[data-section-body="bots"]') as HTMLElement;
    expect(bots.style.maxHeight).toBe("176px");
    Object.defineProperty(bots, "offsetHeight", { configurable: true, value: 176 });
    const handle = screen.getByRole("separator", { name: "Resize Bots" });
    fireEvent.keyDown(handle, { key: "ArrowDown" });
    await waitFor(() => expect(bots.style.maxHeight).toBe("220px"));
    expect(JSON.parse(localStorage.getItem("hermes-chats-view:user-a")!).heights).toEqual({ bots: 220 });
    Object.defineProperty(bots, "offsetHeight", { configurable: true, value: 220 });
    fireEvent.pointerDown(handle, { button: 0, clientY: 100 });
    fireEvent.pointerMove(window, { clientY: 40 });
    fireEvent.pointerUp(window);
    await waitFor(() => expect(bots.style.maxHeight).toBe("160px"));
  });
  it("lets no other section take My chats' slot when My chats is collapsed", async () => {
    const user = userEvent.setup(); render(<Harness />);
    await screen.findByRole("button", { name: "Open Sourcing Requests" });
    await user.click(screen.getByRole("button", { name: /^My chats \d+$/ }));
    expect([...document.querySelectorAll<HTMLElement>("[data-section]")].some((node) => node.style.flex === "1 1 0px")).toBe(false);
  });
  it("orders by last activity and does not move a chat when it is opened", async () => {
    sessions = [chat("alpha", "busy", 900, { working: true }), chat("alpha", "quiet", 500), chat("alpha", "finished", 400)];
    localStorage.setItem("hermes-chats-seen:user-a", JSON.stringify({ [chat("alpha", "finished", 0).key]: 100 }));
    const user = userEvent.setup(); render(<Harness />);
    await screen.findByRole("button", { name: "Open alpha busy" });
    const order = () => [...document.querySelectorAll('[data-section-body="mine"] [data-conversation-key]')].map((row) => row.querySelector("button")!.getAttribute("aria-label"));
    expect(order()).toEqual(["Open alpha busy", "Open alpha quiet", "Open alpha finished"]);
    await user.click(screen.getByRole("button", { name: "Open alpha finished" }));
    expect(order()).toEqual(["Open alpha busy", "Open alpha quiet", "Open alpha finished"]);
  });
  it("hides scrollbars on the sidebar sections", async () => {
    render(<Harness />);
    await screen.findByRole("button", { name: "Open Sourcing Requests" });
    for (const body of document.querySelectorAll("[data-section-body]")) expect(body).toHaveClass("no-scrollbar");
  });
});
