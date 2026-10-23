// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { applyChatView, DEFAULT_VIEW, type HermesConversation } from "@/lib/hermes-conversations";
import { HermesConversationList, type HermesChatsController } from "./hermes-conversations";
import { useConversationReorderMotion } from "./use-conversation-reorder-motion";

const preference = vi.hoisted(() => ({ reduced: false as boolean | null }));
// Keep the real Motion layout engine. Only control the OS preference in jsdom.
vi.mock("framer-motion", async (original) => ({ ...await original<typeof import("framer-motion")>(), useReducedMotion: () => preference.reduced }));
vi.mock("./profile-avatar", () => ({ ProfileAvatar: () => <span /> }));
const access = { visibility: "team" as const, ownerId: null, canShare: false, canDelete: false, canWrite: true, canApprove: true };
const rows: HermesConversation[] = [
  { access, key: "new", id: "new", kind: "solo", title: "Newer chat", updatedAt: 200, working: false, project: "Beacon", participants: [] },
  { access, key: "old", id: "old", kind: "solo", title: "Older chat", updatedAt: 100, working: true, project: "Beacon", participants: [] },
];
const sections = (sessions = rows) => applyChatView(sessions, DEFAULT_VIEW, "").sections;
function controller(sessions = rows) {
  return { ready: true, listing: { userId: "user-a", sessions, warnings: [] }, filter: null, selected: rows[1], seen: {}, error: null, select: vi.fn() } as unknown as HermesChatsController;
}
beforeEach(() => { preference.reduced = false; localStorage.clear(); });
afterEach(() => { vi.restoreAllMocks(); });

describe("conversation reorder motion", () => {
  it("baselines hydration and view changes, but animates subsequent activity ordering", () => {
    const { result, rerender } = renderHook(({ items, scope }) => useConversationReorderMotion(items, scope), { initialProps: { items: sections(), scope: "hydrating" } });
    expect(result.current.transition.layout.duration).toBe(0);
    rerender({ items: sections(), scope: "saved-project-view" });
    expect(result.current.transition.layout.duration).toBe(0);
    const baseline = result.current.layoutDependency;
    rerender({ items: sections(rows.map((row) => ({ ...row, working: !row.working, updatedAt: row.updatedAt + 1 }))), scope: "saved-project-view" });
    expect(result.current.layoutDependency).toBe(baseline); // Refresh/status changes cannot trigger travel.
    rerender({ items: sections([{ ...rows[1], updatedAt: 300 }, rows[0]]), scope: "saved-project-view" });
    expect(result.current.layoutDependency).not.toBe(baseline);
    expect(result.current.layout).toBe("position");
    expect(result.current.transition.layout.duration).toBe(0.22);
    expect(result.current.initial).toBe(false);
    rerender({ items: sections(), scope: "search-or-pin-or-filter-change" });
    expect(result.current.transition.layout.duration).toBe(0);
  });

  it("baselines section membership and header reordering instead of crossing headers", () => {
    const first = sections();
    const { result, rerender } = renderHook(({ items }) => useConversationReorderMotion(items, "same-view"), { initialProps: { items: first } });
    const added = sections([...rows, { ...rows[0], id: "added", key: "added", updatedAt: 500 }]);
    rerender({ items: added });
    expect(result.current.transition.layout.duration).toBe(0);
    const grouped = [{ key: "first", label: "First", rows: [rows[0]] }, { key: "second", label: "Second", rows: [rows[1]] }];
    rerender({ items: grouped });
    rerender({ items: [...grouped].reverse() });
    expect(result.current.transition.layout.duration).toBe(0);
  });

  it.each([true, null])("disables layout travel for reduced/unknown preference %s", (reduced) => {
    preference.reduced = reduced;
    const { result, rerender } = renderHook(({ items }) => useConversationReorderMotion(items, "same-view"), { initialProps: { items: sections() } });
    rerender({ items: sections([{ ...rows[1], updatedAt: 300 }, rows[0]]) });
    expect(result.current.layout).toBe(false);
    expect(result.current.transition.layout.duration).toBe(0);
  });

  it("uses real layout projection to swap stable rows without losing focus, selection or scroll", async () => {
    // Synthetic row geometry supplies only the layout jsdom lacks. No browser or API is used.
    const original = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.hasAttribute("data-conversation-key")) {
        const siblings = Array.from(this.parentElement!.querySelectorAll("[data-conversation-key]"));
        return new DOMRect(0, siblings.indexOf(this) * 48, 280, 48);
      }
      return original.call(this);
    });
    const { rerender } = render(<HermesConversationList chats={controller()} />);
    const focused = screen.getByRole("button", { name: "Open Older chat" });
    const oldRow = focused.closest<HTMLElement>("[data-conversation-key]")!;
    const newRow = screen.getByRole("button", { name: "Open Newer chat" }).closest<HTMLElement>("[data-conversation-key]")!;
    const scroller = screen.getByLabelText("Hermes conversations");
    scroller.scrollTop = 12;
    focused.focus();
    // Let Motion finish its initial measurement before delivering activity.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)); });
    const transforms: string[][] = [];
    const observer = new MutationObserver(() => transforms.push([oldRow.style.transform, newRow.style.transform]));
    observer.observe(oldRow, { attributes: true, attributeFilter: ["style"] });
    observer.observe(newRow, { attributes: true, attributeFilter: ["style"] });
    rerender(<HermesConversationList chats={controller([{ ...rows[1], updatedAt: 300 }, rows[0]])} />);
    expect(screen.getAllByRole("button", { name: /^Open / }).map((button) => button.textContent)).toEqual([expect.stringContaining("Older chat"), expect.stringContaining("Newer chat")]);
    expect(screen.getByRole("button", { name: "Open Older chat" })).toBe(focused);
    expect(focused).toHaveFocus();
    expect(focused).toHaveAttribute("aria-current", "true");
    expect(scroller.scrollTop).toBe(12);
    await waitFor(() => {
      expect(transforms.some(([old, newer]) =>
        /translate3d\(0px, [\d.]+px, 0px\)/.test(old) &&
        /translate3d\(0px, -[\d.]+px, 0px\)/.test(newer)), JSON.stringify(transforms)).toBe(true);
    });
    await waitFor(() => {
      expect(oldRow.style.transform).toBe("none");
      expect(newRow.style.transform).toBe("none");
    });
    transforms.length = 0;
    rerender(<HermesConversationList chats={controller([{ ...rows[1], updatedAt: 301 }, { ...rows[0], working: true }])} />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)); });
    expect(oldRow.style.transform).toBe("none");
    expect(newRow.style.transform).toBe("none");
    expect(transforms.some((pair) => pair.some((value) => value.includes("translate")))).toBe(false);
    observer.disconnect();
  });
});
