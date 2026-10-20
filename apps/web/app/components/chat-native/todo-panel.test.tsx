// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TodoPanel, splitTodo } from "./todo-panel";
import type { TodoState } from "@/lib/hermes-chat/todos";

const state = (visible: TodoState["visible"]): TodoState => ({ visible, retained: [] }) as unknown as TodoState;
const items = [
  { id: "a", content: "Worktree ready: created and symlinked", status: "completed" },
  { id: "b", content: "Shimmer rework: skeletons built from the real structure", status: "in_progress" },
  { id: "c", content: "Ship", status: "pending" },
] as TodoState["visible"];

describe("splitTodo", () => {
  it("uses the text before the first colon as the title", () => {
    expect(splitTodo("Collapsible list: drag past a threshold")).toEqual({ title: "Collapsible list", detail: "drag past a threshold" });
  });
  it("keeps short text whole and truncates long colon-less text", () => {
    expect(splitTodo("Ship")).toEqual({ title: "Ship", detail: "" });
    const long = "word ".repeat(30).trim();
    const out = splitTodo(long);
    expect(out.title.endsWith("…")).toBe(true);
    expect(out.detail).toBe(long);
  });
});

describe("TodoPanel", () => {
  it("shows progress, expands only the active row, and toggles detail on click", () => {
    const { container } = render(<TodoPanel todos={state(items)} />);
    expect(screen.getByText("1/3 done")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "1");
    expect(screen.getByText("skeletons built from the real structure")).toBeInTheDocument();
    expect(screen.queryByText("created and symlinked")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Worktree ready/ }));
    expect(screen.getByText("created and symlinked")).toBeInTheDocument();
    expect(container.querySelector('[data-todo-id="b"]')?.getAttribute("data-status")).toBe("in_progress");
  });
  it("hides finished rows on demand", () => {
    render(<TodoPanel todos={state(items)} />);
    fireEvent.click(screen.getByRole("button", { name: "Hide done" }));
    expect(screen.queryByText("Worktree ready")).toBeNull();
    expect(screen.getByRole("button", { name: "Show done (1)" })).toBeInTheDocument();
  });
  it("collapses to one line showing the active task and starts collapsed when everything is done", () => {
    const { rerender } = render(<TodoPanel todos={state(items)} />);
    fireEvent.click(screen.getByRole("button", { name: "Tasks" }));
    expect(screen.queryByText("created and symlinked")).toBeNull();
    expect(screen.getByText("Shimmer rework")).toBeInTheDocument();
    rerender(<TodoPanel key="all-done" todos={state(items.map(item => ({ ...item, status: "completed" })) as TodoState["visible"])} />);
    expect(screen.getByRole("button", { name: "Tasks" })).toHaveAttribute("aria-expanded", "false");
  });
});
