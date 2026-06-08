import { describe, expect, it } from "vitest";
import { buildSkillTemplatePrompt } from "./skill-templates";
import { parseQuestionBlock, splitQuestionBlocks } from "./question-blocks";

describe("question blocks", () => {
  it("parses a valid single-choice question block", () => {
    expect(parseQuestionBlock(JSON.stringify({
      id: "crm-source",
      prompt: "Where should I save leads?",
      options: [
        { id: "dench", label: "Dench CRM" },
        { id: "hubspot", label: "HubSpot", description: "Sync after review" },
      ],
    }))).toEqual({
      id: "crm-source",
      prompt: "Where should I save leads?",
      allowMultiple: false,
      optional: false,
      options: [
        { id: "dench", label: "Dench CRM" },
        { id: "hubspot", label: "HubSpot", description: "Sync after review" },
      ],
    });
  });

  it("parses optional multi-choice metadata", () => {
    expect(parseQuestionBlock(JSON.stringify({
      id: "signals",
      prompt: "Which buying signals matter?",
      allowMultiple: true,
      optional: true,
      optionalDetailsPlaceholder: "Add any custom signal...",
      options: [
        { id: "hiring", label: "Hiring sales roles" },
        { id: "funding", label: "Raised funding" },
      ],
    }))).toMatchObject({
      id: "signals",
      allowMultiple: true,
      optional: true,
      optionalDetailsPlaceholder: "Add any custom signal...",
    });
  });

  it("rejects malformed or ambiguous question blocks", () => {
    expect(parseQuestionBlock("{")).toBeNull();
    expect(parseQuestionBlock(JSON.stringify({ id: "missing-options", prompt: "Choose" }))).toBeNull();
    expect(parseQuestionBlock(JSON.stringify({
      id: "one-option",
      prompt: "Choose",
      options: [{ id: "only", label: "Only" }],
    }))).toBeNull();
    expect(parseQuestionBlock(JSON.stringify({
      id: "dupes",
      prompt: "Choose",
      options: [
        { id: "same", label: "One" },
        { id: "same", label: "Two" },
      ],
    }))).toBeNull();
  });

  it("splits text and valid dench-question fences", () => {
    const segments = splitQuestionBlocks(`Before.

\`\`\`dench-question
{
  "id": "trigger",
  "prompt": "How should this run?",
  "options": [
    { "id": "manual", "label": "Manual trigger" },
    { "id": "cron", "label": "Cron job" }
  ]
}
\`\`\`

After.`);

    expect(segments).toHaveLength(3);
    expect(segments[0]).toEqual({ type: "text", text: "Before.\n\n" });
    expect(segments[1]).toMatchObject({
      type: "question",
      question: {
        id: "trigger",
        prompt: "How should this run?",
      },
    });
    expect(segments[2]).toEqual({ type: "text", text: "\n\nAfter." });
  });

  it("keeps invalid dench-question fences as text", () => {
    const text = "Pick:\n\n```dench-question\nnot json\n```";
    expect(splitQuestionBlocks(text)).toEqual([{ type: "text", text }]);
  });

  it("parses the canonical dench-question shape embedded in template prompts", () => {
    const prompt = buildSkillTemplatePrompt("icp-outreach-builder");
    const segments = splitQuestionBlocks(prompt);
    const questionSegments = segments.filter(
      (segment) => segment.type === "question",
    );

    expect(questionSegments).toHaveLength(1);
    expect(questionSegments[0]).toMatchObject({
      type: "question",
      question: {
        id: "short-stable-question-id",
        prompt: "The one question you need answered",
        allowMultiple: false,
        optional: false,
        options: [
          { id: "first-option", label: "First option" },
          { id: "second-option", label: "Second option" },
        ],
      },
    });
  });
});
