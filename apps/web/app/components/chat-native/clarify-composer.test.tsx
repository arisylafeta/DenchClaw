// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PromptDock } from "./prompt-dock";
import { initialState, type PendingRequest } from "@/lib/hermes-chat/reducer";
import type { NativeTranscriptCallbacks } from "./types";

afterEach(cleanup);
it("uses Jules' compact shared input row without a visible Other heading or submit block", () => {
  render(<Fixture />);
  const row = screen.getByTestId("composer").querySelector("[data-clarify-composer]")!;
  const field = within(row as HTMLElement).getByRole("textbox", { name: "Other" });
  expect(field).toHaveAttribute("rows", "1");
  expect(field).toHaveClass("min-h-8", "border-0", "bg-transparent");
  expect(field.parentElement).toBe(within(row as HTMLElement).getByRole("button", { name: "Send answer" }).parentElement);
  expect(screen.getByText("Other", { selector: "label" })).toHaveClass("sr-only");
  expect(screen.queryByRole("button", { name: "Submit answer" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
});
it("supports four-way arrows, number selection, typeahead and IME-safe free answers", () => {
  const pending: PendingRequest = { id: "keyboard", kind: "clarify", payload: { questions: [
    { qid: "route", question: "Route?", choices: ["North", "South", "Other"] },
    { qid: "note", question: "Why?" },
  ] } };
  const onClarify = vi.fn();
  render(<Fixture requests={[pending]} onClarify={onClarify} />);
  const north = screen.getByRole("radio", { name: /North/ });
  expect(north).toHaveFocus();
  fireEvent.keyDown(north, { key: "ArrowRight" });
  const south = screen.getByRole("radio", { name: /South/ });
  expect(south).toHaveFocus();
  fireEvent.keyDown(south, { key: "ArrowLeft" });
  expect(north).toHaveFocus();
  fireEvent.keyDown(north, { key: "c" });
  expect(screen.getByRole("textbox")).toHaveFocus();
  expect(screen.getByRole("textbox")).toHaveValue("c");
  north.focus(); fireEvent.keyDown(north, { key: "2" });
  expect(screen.getByText("2 of 2")).toBeInTheDocument();
  const field = screen.getByRole("textbox");
  fireEvent.change(field, { target: { value: "Typed answer" } });
  fireEvent.keyDown(field, { key: "Enter", isComposing: true });
  fireEvent.keyDown(field, { key: "Enter", keyCode: 229 });
  fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
  expect(onClarify).not.toHaveBeenCalled();
  fireEvent.keyDown(field, { key: "Enter" });
  expect(onClarify).toHaveBeenCalledExactlyOnceWith(pending, { route: "South", note: "Typed answer" });
});
it("submits multi-select with Enter and retries a failed send without losing its answer", async () => {
  const pending: PendingRequest = { id: "retry", kind: "clarify", payload: { questions: [{ qid: "parts", question: "Parts?", choices: ["Packs", "Modules"], multi_select: true }] } };
  const onClarify = vi.fn().mockRejectedValueOnce(new Error("Try again")).mockResolvedValue(undefined);
  render(<Fixture requests={[pending]} onClarify={onClarify} />);
  const packs = screen.getByRole("checkbox", { name: /Packs/ });
  fireEvent.click(packs);
  expect(onClarify).not.toHaveBeenCalled();
  fireEvent.keyDown(packs, { key: "Enter" });
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Try again"));
  expect(screen.getByRole("checkbox", { name: /Packs/ })).toHaveAttribute("aria-checked", "true");
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(onClarify).toHaveBeenCalledTimes(2);
  expect(onClarify).toHaveBeenLastCalledWith(pending, { parts: "Packs" });
});
it("locks repeated free-answer submissions while the request is in flight", () => {
  const onClarify = vi.fn(() => new Promise<void>(() => {}));
  render(<Fixture onClarify={onClarify} />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Cells" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  const field = screen.getByRole("textbox");
  fireEvent.change(field, { target: { value: "Berlin" } });
  fireEvent.keyDown(field, { key: "Enter" });
  fireEvent.keyDown(field, { key: "Enter" });
  expect(onClarify).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
});
const request = (id = "request-1"): PendingRequest => ({ id, kind: "clarify", payload: {
  questions: [
    { qid: "locked", question: "Already answered?", choices: ["Yes", "No"] },
    { qid: "parts", question: "Which parts?", choices: ["Packs", "Modules", "Other"], multi_select: true },
    { qid: "note", question: "Where?" },
  ], answers: { locked: "Yes" },
} });
function Fixture({ session = "profile:one", requests = [request()], onClarify = vi.fn(), disabled = false }: { session?: string; requests?: PendingRequest[]; onClarify?: NativeTranscriptCallbacks["onClarify"]; disabled?: boolean }) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  return <><PromptDock key={session} state={{ sessionId: session, pendingRequests: requests }} subagents={initialState(session).subagents}
    composerTarget={target} disabled={disabled} callbacks={{ onClarify, onApproval: vi.fn(), onRetry: vi.fn(), onSubagentTail: vi.fn(), onSubagentSteer: vi.fn(), onSubagentInterrupt: vi.fn() }} />
    <div data-testid="composer" ref={setTarget} /></>;
}
it("keeps choices, text, locked answers and previous/skip anchored to their qids", () => {
  const onClarify = vi.fn(); const pending = request();
  render(<Fixture requests={[pending]} onClarify={onClarify} />);
  expect(within(screen.getByTestId("composer")).getAllByRole("textbox")).toHaveLength(1);
  expect(screen.getByText("Already answered?: Yes")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("checkbox", { name: /Packs/ }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Cells" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(screen.getByRole("textbox")).toHaveValue("");
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Berlin" } });
  fireEvent.click(screen.getByRole("button", { name: "Previous" }));
  expect(screen.getByRole("checkbox", { name: /Packs/ })).toHaveAttribute("aria-checked", "true");
  expect(screen.getByRole("textbox")).toHaveValue("Cells");
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(screen.getByRole("textbox")).toHaveValue("Berlin");
  fireEvent.click(screen.getByRole("button", { name: "Skip" }));
  expect(onClarify).toHaveBeenCalledWith(pending, { locked: "Yes", parts: "Packs, Cells", note: null });
});
it("preserves the active answer and progress when pending requests replay in a new order", () => {
  const first = request(); const second = request("request-2"); const onClarify = vi.fn();
  const { rerender } = render(<Fixture requests={[first, second]} onClarify={onClarify} />);
  fireEvent.click(screen.getByRole("checkbox", { name: /Packs/ }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Cells" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  const textbox = screen.getByRole("textbox");
  fireEvent.change(textbox, { target: { value: "Berlin" } });
  textbox.focus();
  rerender(<Fixture requests={[second, { ...first }]} onClarify={onClarify} />);
  expect(screen.getByRole("textbox")).toBe(textbox);
  expect(textbox).toHaveValue("Berlin");
  expect(textbox).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: "Previous" }));
  expect(screen.getByRole("checkbox", { name: /Packs/ })).toHaveAttribute("aria-checked", "true");
  expect(screen.getByRole("textbox")).toHaveValue("Cells");
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  fireEvent.click(screen.getByRole("button", { name: "Send answer" }));
  expect(onClarify).toHaveBeenCalledWith(first, { locked: "Yes", parts: "Packs, Cells", note: "Berlin" });
});
it("isolates typed answers across request and exact conversation changes; queues other requests", () => {
  const first = request(); const second = request("request-2");
  const { rerender } = render(<Fixture requests={[first, second]} />);
  expect(screen.getAllByRole("textbox")).toHaveLength(1);
  expect(screen.getByText("Another question is waiting")).toBeInTheDocument();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "First answer" } });
  rerender(<Fixture requests={[second]} />);
  expect(screen.getByRole("textbox")).toHaveValue("");
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Second answer" } });
  rerender(<Fixture session="profile:two" requests={[second]} />);
  expect(screen.getByRole("textbox")).toHaveValue("");
});
it("locks input, choice and Continue during transport loss without discarding the answer", () => {
  const pending = request(); const onClarify = vi.fn();
  const view = render(<Fixture requests={[pending]} onClarify={onClarify} />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Cells" } });
  view.rerender(<Fixture requests={[pending]} onClarify={onClarify} disabled />);
  expect(screen.getByRole("textbox")).toBeDisabled();
  expect(screen.getByRole("checkbox", { name: /Packs/ })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Send answer" })).toBeDisabled();
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  expect(onClarify).not.toHaveBeenCalled();
  view.rerender(<Fixture requests={[pending]} onClarify={onClarify} />);
  expect(screen.getByRole("textbox")).toHaveValue("Cells");
  expect(screen.getByRole("button", { name: "Send answer" })).toBeEnabled();
});
