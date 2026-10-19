// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChatEditor } from "./chat-editor";
import { filterAgents, type MentionAgent } from "./agent-mention";

vi.mock("../workspace/profile-avatar", () => ({ ProfileAvatar: ({ name }: { name: string }) => <span data-testid="avatar">{name}</span> }));
const agents: MentionAgent[] = [{ handle: "matcha", name: "Matcha", profile: "matcha" }, { handle: "devon", name: "Devon", profile: "devon" }];
const files = [{ id: "f1", label: "pricing.md", kind: "file", path: "/w/pricing.md", nodeType: "file" }];

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 } as DOMRect);
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function type(text: string) {
  const editor = document.querySelector("[contenteditable=true]") as HTMLElement;
  editor.focus();
  await act(async () => { editor.innerHTML = `<p>${text}</p>`; const range = document.createRange(); range.selectNodeContents(editor.firstElementChild!); range.collapse(false); const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range); fireEvent.input(editor, { inputType: "insertText", data: text }); await new Promise((resolve) => setTimeout(resolve, 40)); });
  return editor;
}

describe("filterAgents", () => {
  it("lists everyone first for a bare @, then prefix matches on handle or name", () => {
    expect(filterAgents(agents, "").map((a) => a.handle)).toEqual(["all", "matcha", "devon"]);
    expect(filterAgents(agents, "ma").map((a) => a.handle)).toEqual(["matcha"]);
    expect(filterAgents(agents, "DEV").map((a) => a.handle)).toEqual(["devon"]);
    expect(filterAgents(agents, "al").map((a) => a.handle)).toEqual(["all"]);
    expect(filterAgents(agents, "zzz")).toEqual([]);
  });
  it("does not offer @all for a single agent", () => {
    expect(filterAgents([agents[0]], "").map((a) => a.handle)).toEqual(["matcha"]);
  });
});

describe("mention triggers in the chat editor", () => {
  it("@ lists the agents of a group chat and inserts a plain @handle", async () => {
    const onSubmit = vi.fn();
    render(<ChatEditor agents={agents} searchFn={() => files as never} onSubmit={onSubmit} />);
    await type("hey @ma");
    const option = await screen.findByRole("option", { name: /Matcha/ });
    expect(screen.queryByText("pricing.md")).toBeNull();
    fireEvent.click(option);
    const editor = document.querySelector("[contenteditable=true]") as HTMLElement;
    expect(editor.textContent).toBe("hey @matcha ");
    expect(editor.querySelector("[data-type], .file-mention, span[data-label]")).toBeNull();
  });
  it("# lists files and tables, never agents", async () => {
    render(<ChatEditor agents={agents} searchFn={() => files as never} onSubmit={vi.fn()} />);
    await type("see #pri");
    expect(await screen.findByText("pricing.md")).toBeTruthy();
    expect(screen.queryByRole("option", { name: /Matcha/ })).toBeNull();
  });
  it("@ outside a group chat stays plain text and offers nothing", async () => {
    render(<ChatEditor searchFn={() => files as never} onSubmit={vi.fn()} />);
    await type("mail me @ma");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)); });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.queryByText("pricing.md")).toBeNull();
  });
});
