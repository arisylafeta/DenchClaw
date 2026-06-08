"use client";

import { useMemo, useState } from "react";
import type { QuestionBlock, QuestionOption } from "@/lib/question-blocks";

type ChatQuestionCardProps = {
  question: QuestionBlock;
  onAnswer?: (answerText: string) => void;
};

export function ChatQuestionCard({ question, onAnswer }: ChatQuestionCardProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [details, setDetails] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [submitted, setSubmitted] = useState<"answered" | "skipped" | null>(null);

  const selectedOptions = useMemo(
    () => question.options.filter((option) => selectedIds.has(option.id)),
    [question.options, selectedIds],
  );
  const customOptionSelected = selectedOptions.some(isCustomOption);
  const showDetails = detailsOpen || customOptionSelected || details.trim().length > 0;
  const canSubmit = selectedOptions.length > 0 && !submitted;
  const modeLabel = question.allowMultiple ? "Select multiple" : "Pick one";

  function toggleOption(optionId: string) {
    if (submitted) {
      return;
    }

    setSelectedIds((previous) => {
      if (!question.allowMultiple) {
        return new Set([optionId]);
      }

      const next = new Set(previous);
      if (next.has(optionId)) {
        next.delete(optionId);
      } else {
        next.add(optionId);
      }
      return next;
    });
  }

  function submitAnswer() {
    if (!canSubmit) {
      return;
    }
    setSubmitted("answered");
    onAnswer?.(formatQuestionAnswer(question, selectedOptions, details));
  }

  function skipQuestion() {
    if (submitted) {
      return;
    }
    setSubmitted("skipped");
    onAnswer?.(formatSkippedQuestion(question, details));
  }

  return (
    <section
      className="my-2 overflow-hidden rounded-xl border"
      style={{
        borderColor: "color-mix(in srgb, var(--color-border) 78%, transparent)",
        background: "var(--color-surface)",
      }}
      aria-label="Question from assistant"
    >
      <div
        className="flex items-center justify-between gap-3 border-b px-3 py-2"
        style={{ borderColor: "color-mix(in srgb, var(--color-border) 70%, transparent)" }}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md border"
            style={{
              borderColor: "var(--color-border)",
              color: "var(--color-text-muted)",
            }}
            aria-hidden="true"
          >
            <QuestionIcon />
          </span>
          <span
            className="text-[11px] font-semibold"
            style={{ color: "var(--color-text-muted)" }}
          >
            Question
          </span>
        </div>
        <span
          className="shrink-0 rounded-md px-2 py-1 text-[11px] font-medium"
          style={{
            background: "color-mix(in srgb, var(--color-accent) 12%, transparent)",
            color: "var(--color-accent)",
          }}
        >
          {modeLabel}
        </span>
      </div>

      <div className="px-3 pb-3 pt-2.5">
        <div className="flex gap-2">
          <span
            className="mt-[2px] shrink-0 text-[13px] font-semibold tabular-nums"
            style={{ color: "var(--color-text-muted)" }}
          >
            1.
          </span>
          <h3
            className="min-w-0 text-[13px] font-semibold leading-relaxed"
            style={{ color: "var(--color-text)" }}
          >
            {question.prompt}
          </h3>
        </div>

        <div className="mt-2 space-y-1.5">
          {question.options.map((option, index) => {
            const selected = selectedIds.has(option.id);
            const letter = String.fromCharCode(65 + index);
            return (
              <button
                key={option.id}
                type="button"
                disabled={!!submitted}
                aria-pressed={selected}
                onClick={() => toggleOption(option.id)}
                className="flex w-full items-start gap-2 rounded-lg border px-2.5 py-2 text-left transition-[background,border-color] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:cursor-default disabled:opacity-70"
                style={{
                  borderColor: selected
                    ? "var(--color-accent)"
                    : "color-mix(in srgb, var(--color-border) 72%, transparent)",
                  background: selected
                    ? "color-mix(in srgb, var(--color-accent) 12%, var(--color-surface))"
                    : "color-mix(in srgb, var(--color-background) 64%, transparent)",
                }}
              >
                <span
                  className="mt-[1px] flex h-5 w-5 shrink-0 items-center justify-center rounded-md border text-[10px] font-semibold"
                  style={{
                    borderColor: selected ? "var(--color-accent)" : "var(--color-border)",
                    background: selected ? "var(--color-accent)" : "transparent",
                    color: selected ? "#fff" : "var(--color-text-muted)",
                  }}
                >
                  {letter}
                </span>
                <span className="min-w-0">
                  <span
                    className="block text-[13px] font-medium leading-5"
                    style={{ color: "var(--color-text)" }}
                  >
                    {option.label}
                  </span>
                  {option.description && (
                    <span
                      className="mt-0.5 block text-[12px] leading-relaxed"
                      style={{ color: "var(--color-text-muted)" }}
                    >
                      {option.description}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>

        {!showDetails && !submitted && (
          <button
            type="button"
            onClick={() => setDetailsOpen(true)}
            className="mt-2 text-[12px] font-medium"
            style={{ color: "var(--color-text-muted)" }}
          >
            Add details
          </button>
        )}

        {showDetails && (
          <label className="mt-2 block">
            <span
              className="sr-only"
            >
              Optional context
            </span>
            <textarea
              value={details}
              disabled={!!submitted}
              onChange={(event) => setDetails(event.target.value)}
              placeholder={question.optionalDetailsPlaceholder ?? "Add optional details..."}
              className="min-h-[56px] w-full resize-y rounded-lg border px-2.5 py-2 text-[13px] leading-relaxed outline-none transition-[border-color,box-shadow] disabled:opacity-70"
              style={{
                borderColor: "var(--color-border)",
                background: "var(--color-background)",
                color: "var(--color-text)",
              }}
              onFocus={(event) => {
                event.currentTarget.style.borderColor = "var(--color-accent)";
                event.currentTarget.style.boxShadow =
                  "0 0 0 3px color-mix(in srgb, var(--color-accent) 14%, transparent)";
              }}
              onBlur={(event) => {
                event.currentTarget.style.borderColor = "var(--color-border)";
                event.currentTarget.style.boxShadow = "none";
              }}
            />
          </label>
        )}

        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="min-h-5 text-[12px]" style={{ color: "var(--color-text-muted)" }}>
            {submitted === "answered" && "Answer sent"}
            {submitted === "skipped" && "Skipped"}
            {!submitted && selectedOptions.length > 0 &&
              `${selectedOptions.length} selected`}
          </div>
          <div className="flex items-center gap-2">
            {question.optional && (
              <button
                type="button"
                disabled={!!submitted}
                onClick={skipQuestion}
                className="h-7 rounded-md px-2 text-[12px] font-medium transition-opacity disabled:opacity-50"
                style={{
                  color: "var(--color-text-muted)",
                  background: "transparent",
                }}
              >
                Skip
              </button>
            )}
            <button
              type="button"
              disabled={!canSubmit}
              onClick={submitAnswer}
              className="h-7 rounded-md px-3 text-[12px] font-semibold transition-opacity disabled:opacity-50"
              style={{
                background: "var(--color-accent)",
                color: "#fff",
              }}
            >
              {submitted ? "Sent" : "Continue"}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function QuestionIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 15a4 4 0 0 1-4 4H7l-4 4V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z" />
      <path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 1.5-1.5 2-2.5 2.75" />
      <path d="M12 16h.01" />
    </svg>
  );
}

function isCustomOption(option: QuestionOption): boolean {
  const text = `${option.id} ${option.label}`.toLowerCase();
  return /\b(custom|other|specify|something-else)\b/.test(text);
}

function formatQuestionAnswer(
  question: QuestionBlock,
  selectedOptions: QuestionOption[],
  details: string,
): string {
  const optionLines = selectedOptions
    .map((option) => `- ${option.label} (${option.id})`)
    .join("\n");
  const detailText = details.trim();

  return [
    `Answer to "${question.prompt}"`,
    `Question ID: ${question.id}`,
    question.allowMultiple ? "Selected options:" : "Selected option:",
    optionLines,
    detailText ? `Additional context:\n${detailText}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function formatSkippedQuestion(question: QuestionBlock, details: string): string {
  const detailText = details.trim();
  return [
    `Skipped question "${question.prompt}"`,
    `Question ID: ${question.id}`,
    detailText ? `Additional context:\n${detailText}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
