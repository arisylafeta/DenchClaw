// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PromptDock } from "./prompt-dock";
import { initialState, type PendingRequest } from "@/lib/hermes-chat/reducer";
import type { NativeTranscriptCallbacks } from "./types";

afterEach(cleanup);
const request = (id = "request-1"): PendingRequest => ({ id, kind: "clarify", payload: {
  questions: [
    { qid: "locked", question: "Already answered?", choices: ["Yes", "No"] },
    { qid: "parts", question: "Which parts?", choices: ["Packs", "Modules", "Other"], multi_select: true },
    { qid: "note", question: "Where?" },
  ], answers: { locked: "Yes" },
} });
function Fixture({ session = "profile:one", requests = [request()], onClarify = vi.fn() }: { session?: string; requests?: PendingRequest[]; onClarify?: NativeTranscriptCallbacks["onClarify"] }) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  return <><PromptDock key={session} state={{ sessionId: session, pendingRequests: requests }} subagents={initialState(session).subagents}
    composerTarget={target} callbacks={{ onClarify, onApproval: vi.fn(), onRetry: vi.fn(), onSubagentTail: vi.fn(), onSubagentSteer: vi.fn(), onSubagentInterrupt: vi.fn() }} />
    <div data-testid="composer" ref={setTarget} /></>;
}
it("keeps choices, text, locked answers and previous/skip anchored to their qids", () => {
  const onClarify = vi.fn(); const pending = request();
  render(<Fixture requests={[pending]} onClarify={onClarify} />);
  expect(within(screen.getByTestId("composer")).getAllByRole("textbox")).toHaveLength(1);
  expect(screen.getByText("Already answered?: Yes")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("checkbox", { name: /Packs/ }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Cells" } });
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(screen.getByRole("textbox")).toHaveValue("");
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Berlin" } });
  fireEvent.click(screen.getByRole("button", { name: "Previous" }));
  expect(screen.getByRole("checkbox", { name: /Packs/ })).toHaveAttribute("aria-checked", "true");
  expect(screen.getByRole("textbox")).toHaveValue("Cells");
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(screen.getByRole("textbox")).toHaveValue("Berlin");
  fireEvent.click(screen.getByRole("button", { name: "Skip" }));
  expect(onClarify).toHaveBeenCalledWith(pending, { locked: "Yes", parts: "Packs, Cells", note: null });
});
it("preserves the active answer and progress when pending requests replay in a new order", () => {
  const first = request(); const second = request("request-2"); const onClarify = vi.fn();
  const { rerender } = render(<Fixture requests={[first, second]} onClarify={onClarify} />);
  fireEvent.click(screen.getByRole("checkbox", { name: /Packs/ }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Cells" } });
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
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
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));
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
