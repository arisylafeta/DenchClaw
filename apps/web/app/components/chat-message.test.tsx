// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatMessage } from "./chat-message";

vi.mock("next/dynamic", () => ({
  default: () => () => null,
}));

vi.mock("posthog-js", () => ({
  default: {
    get_distinct_id: vi.fn(() => "distinct-id"),
  },
}));

vi.mock("posthog-js/react/surveys", () => ({
  useThumbSurvey: vi.fn(() => ({
    respond: vi.fn(),
    response: null,
    triggerRef: { current: null },
  })),
}));

beforeEach(() => {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ChatMessage", () => {
  it("shows the speaker action for completed assistant text when voice playback is enabled", () => {
    render(
      <ChatMessage
        message={{
          id: "assistant-1",
          role: "assistant",
          parts: [{ type: "text", text: "Hello from Dench." }],
        }}
        voicePlaybackEnabled
      />,
    );

    expect(screen.getByRole("button", { name: "Play voice" })).toBeInTheDocument();
  });

  it("copies assistant turns from the inline copy action", async () => {
    const user = userEvent.setup();
    const writeTextSpy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();

    render(
      <ChatMessage
        message={{
          id: "assistant-copy",
          role: "assistant",
          parts: [{ type: "text", text: "Hello from Dench." }],
        }}
        copyable
      />,
    );

    await user.click(screen.getByRole("button", { name: "Copy message" }));

    expect(writeTextSpy).toHaveBeenCalledWith("Hello from Dench.");
  });

  it("copies user turns with attachment metadata", async () => {
    const user = userEvent.setup();
    const writeTextSpy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();

    render(
      <ChatMessage
        message={{
          id: "user-copy",
          role: "user",
          parts: [{
            type: "text",
            text: "[Attached files: /tmp/alpha.ts, /tmp/beta.ts] Please compare these files.",
          }],
        }}
        copyable
      />,
    );

    await user.click(screen.getByRole("button", { name: "Copy message" }));

    expect(writeTextSpy).toHaveBeenCalledWith(
      "Please compare these files.\n\nAttached files:\n/tmp/alpha.ts\n/tmp/beta.ts",
    );
  });

  it("hides the speaker action while the assistant message is still streaming", () => {
    render(
      <ChatMessage
        message={{
          id: "assistant-2",
          role: "assistant",
          parts: [{ type: "text", text: "Still thinking..." }],
        }}
        isStreaming
        voicePlaybackEnabled
      />,
    );

    expect(screen.queryByRole("button", { name: "Play voice" })).not.toBeInTheDocument();
  });

  it("renders dench-question blocks as single-choice cards", async () => {
    const user = userEvent.setup();
    const onQuestionAnswer = vi.fn();

    render(
      <ChatMessage
        message={{
          id: "assistant-question-single",
          role: "assistant",
          parts: [{
            type: "text",
            text: `Pick a system of record.

\`\`\`dench-question
{
  "id": "system-of-record",
  "prompt": "Where should I save new leads?",
  "options": [
    { "id": "dench", "label": "Dench CRM" },
    { "id": "hubspot", "label": "HubSpot" }
  ]
}
\`\`\``,
          }],
        }}
        onQuestionAnswer={onQuestionAnswer}
      />,
    );

    expect(screen.getByText("Pick a system of record.")).toBeInTheDocument();
    expect(screen.getByText("Where should I save new leads?")).toBeInTheDocument();
    expect(screen.queryByText(/dench-question/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Dench CRM/ }));
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(onQuestionAnswer).toHaveBeenCalledWith(expect.stringContaining("Dench CRM (dench)"));
  });

  it("supports multi-choice dench-question cards", async () => {
    const user = userEvent.setup();
    const onQuestionAnswer = vi.fn();

    render(
      <ChatMessage
        message={{
          id: "assistant-question-multi",
          role: "assistant",
          parts: [{
            type: "text",
            text: `\`\`\`dench-question
{
  "id": "signals",
  "prompt": "Which buying signals should matter?",
  "allowMultiple": true,
  "optional": true,
  "options": [
    { "id": "hiring", "label": "Hiring sales roles" },
    { "id": "funding", "label": "Raised funding" },
    { "id": "new-tool", "label": "Recently adopted a competitor" }
  ]
}
\`\`\``,
          }],
        }}
        onQuestionAnswer={onQuestionAnswer}
      />,
    );

    expect(screen.getByText("Select multiple")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Hiring sales roles/ }));
    await user.click(screen.getByRole("button", { name: /Raised funding/ }));
    await user.click(screen.getByRole("button", { name: "Continue" }));

    const answer = onQuestionAnswer.mock.calls[0][0] as string;
    expect(answer).toContain("Selected options:");
    expect(answer).toContain("Hiring sales roles (hiring)");
    expect(answer).toContain("Raised funding (funding)");
  });

  it("lets optional dench-question cards be skipped with context", async () => {
    const user = userEvent.setup();
    const onQuestionAnswer = vi.fn();

    render(
      <ChatMessage
        message={{
          id: "assistant-question-optional",
          role: "assistant",
          parts: [{
            type: "text",
            text: `\`\`\`dench-question
{
  "id": "crm-write-policy",
  "prompt": "Should the skill update CRM fields automatically?",
  "optional": true,
  "optionalDetailsPlaceholder": "Describe your CRM rule...",
  "options": [
    { "id": "draft-only", "label": "Draft updates only" },
    { "id": "auto-write", "label": "Write with source notes" }
  ]
}
\`\`\``,
          }],
        }}
        onQuestionAnswer={onQuestionAnswer}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Add details" }));
    await user.type(
      screen.getByPlaceholderText("Describe your CRM rule..."),
      "Decide this after the first run.",
    );
    await user.click(screen.getByRole("button", { name: "Skip" }));

    expect(onQuestionAnswer).toHaveBeenCalledWith(
      [
        'Skipped question "Should the skill update CRM fields automatically?"',
        "Question ID: crm-write-policy",
        "Additional context:\nDecide this after the first run.",
      ].join("\n\n"),
    );
  });

  it("renders persisted tool failures with their error details", async () => {
    const user = userEvent.setup();

    render(
      <ChatMessage
        message={{
          id: "assistant-persisted-error",
          role: "assistant",
          parts: [{
            type: "tool-invocation",
            toolCallId: "tool-call-error",
            toolName: "github_create_issue",
            args: {
              execution_ref: "exec_posthog_1",
              arguments: {
                project_id: "proj_123",
              },
            },
            result: {
              tool_slug: "POSTHOG_LIST_ALL_PROJECTS_ACROSS_ORGANIZATIONS",
              toolkit: "posthog",
              tool_router_session_id: "trs_posthog_123",
            },
            errorText:
              "Validation failed for tool \"github_create_issue\": execution_ref is required.",
          } as never],
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: /thought/i }));

    expect(
      screen.getByText(/Validation failed for tool "github_create_issue"/),
    ).toBeInTheDocument();
    expect(screen.getByText(/"project_id": "proj_123"/)).toBeInTheDocument();
  });

  it("renders live tool failures with streamed output errors", async () => {
    const user = userEvent.setup();

    render(
      <ChatMessage
        message={{
          id: "assistant-streaming-error",
          role: "assistant",
          parts: [{
            type: "dynamic-tool",
            toolCallId: "tool-call-live-error",
            toolName: "github_create_issue",
            state: "error",
            input: {
              execution_ref: "exec_posthog_1",
            },
            output: {
              tool_slug: "POSTHOG_LIST_ALL_PROJECTS_ACROSS_ORGANIZATIONS",
              toolkit: "posthog",
              tool_router_session_id: "trs_posthog_123",
              error: "Gateway rejected the bridge invocation.",
            },
          } as never],
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: /thought/i }));

    expect(
      screen.getByText(/Gateway rejected the bridge invocation./),
    ).toBeInTheDocument();
  });

  it("opens and closes a preview for sent image attachments", async () => {
    const user = userEvent.setup();

    render(
      <ChatMessage
        message={{
          id: "user-attachment-1",
          role: "user",
          parts: [{ type: "text", text: "[Attached files: assets/screenshot.png]" }],
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Open image screenshot.png" }));

    expect(screen.getByRole("dialog", { name: "Image preview screenshot.png" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close image preview" }));

    expect(screen.queryByRole("dialog", { name: "Image preview screenshot.png" })).not.toBeInTheDocument();
  });
});
