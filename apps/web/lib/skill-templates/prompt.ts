import type {
  SkillTemplateDefinition,
  SkillTemplateInterviewQuestion,
} from "./types";
import { buildComposioChatActionHref } from "../composio-chat-actions";

function bulletList(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

function formatQuestion(question: SkillTemplateInterviewQuestion, index: number): string {
  const required = question.required ? "required" : "optional";
  const mode = question.allowMultiple ? "multi-select" : "single-answer";
  const optionText = question.options?.length
    ? ` Choices: ${question.options
        .map((option) =>
          option.description
            ? `${option.label} (${option.id}) - ${option.description}`
            : `${option.label} (${option.id})`,
        )
        .join("; ")}.`
    : "";
  const freeform = question.freeformHint
    ? ` Freeform guidance: ${question.freeformHint}.`
    : "";

  return `${index + 1}. ${question.prompt} [id: ${question.id}; ${required}; ${mode}].${optionText}${freeform}`;
}

function formatSuggestedAppConnections(template: SkillTemplateDefinition): string {
  if (!template.suggestedApps.length) {
    return "No suggested app connections for this template.";
  }

  return template.suggestedApps
    .map((app) => {
      const href = buildComposioChatActionHref("connect", {
        toolkitSlug: app.slug,
        toolkitName: app.name,
      });
      return `- [Connect ${app.name}](${href})`;
    })
    .join("\n");
}

export function buildSkillTemplatePromptText(template: SkillTemplateDefinition): string {
  const triggerModes = template.triggerModes
    .map((mode) => (mode === "scheduled" ? "cron/scheduled agent message" : "manual trigger"))
    .join(" and ");
  const personas = template.personas.join(", ");
  const suggestedApps = template.suggestedApps.length
    ? template.suggestedApps.map((app) => app.name).join(", ")
    : "no external apps; use Dench-native CRM, enrichment, web search, local files, and workspace context";
  const suggestedAppConnections = formatSuggestedAppConnections(template);

  return `I want to create a reusable DenchClaw skill called "${template.title}".

This should become a durable DenchClaw skill, not a one-off chat. DenchClaw is my AI workspace with built-in CRM, enrichment, Apollo-style data, web search, local files, and optional connected apps. Treat Dench-native capabilities as available by default, and use connected apps only when they are required or helpful.

This template is mainly for these personas: ${personas}.

Suggested app connections for this template: ${suggestedApps}. These are not required to start the interview; they only unlock stronger source context or write-back later.

If suggested app connections exist, before the first interview question briefly show them as optional setup buttons and tell me I can skip them for now. Use exactly these markdown links so the chat renders Connect buttons:
${suggestedAppConnections}

Who this skill is for and when it should help:
${template.userUseCase}

The desired outcome is:
${template.outcome}

Available trigger modes for this product are only manual trigger and cron/scheduled agent messages. For this skill, design around ${triggerModes}. Do not assume webhooks, event listeners, or automatic app callbacks exist.

Start by interviewing me one question at a time. Do not echo this setup back to me. Ask only 3-5 focused questions before creating the skill unless a safety-critical automation rule is still missing. Ask the smallest next question needed, keep each interview turn under 120 words unless options are essential, wait for my answer, then ask the next question. Do not create or edit any files until you have enough context to tailor the workflow.

When the next question has clear choices, ask it with a Dench question card instead of plain text bullets. Use this exact fenced JSON shape, then stop and wait for my selection:
\`\`\`dench-question
{
  "id": "short-stable-question-id",
  "prompt": "The one question you need answered",
  "allowMultiple": false,
  "optional": false,
  "options": [
    { "id": "first-option", "label": "First option" },
    { "id": "second-option", "label": "Second option" }
  ]
}
\`\`\`
Set "allowMultiple": true only when more than one option can be selected. Add "optional": true only when skipping is genuinely acceptable. Keep option labels short and include descriptions only when they prevent ambiguity.

Before writing the final SKILL.md, gather these specifics:
${template.interviewQuestions.map(formatQuestion).join("\n")}

Ask the questions in that order unless my answer makes a later question unnecessary. If a question lists choices, prefer a dench-question card with the provided IDs and labels so I can answer quickly. Still accept custom freeform detail when my situation does not fit the choices.

When you have enough context, create a complete SKILL.md for this reusable skill. Do not assume a skill-creator helper exists; if no helper is available, create the skill directly at skills/<kebab-case-skill-name>/SKILL.md and add references under that folder when useful. The skill should include:
${bulletList(template.skillInstructions)}

The final SKILL.md must include a concrete activity logger policy. Do not add a generic "log activity" note; specify where the log lives, when entries are appended, which fields are recorded, what gets suppressed on repeat runs, and what must be redacted. Use this tailored logger contract:
${bulletList(template.activityLogInstructions)}

Automation policy:
- If the skill sends email or LinkedIn-style outreach, it may be fully automated only after you define explicit send rules with me.
- Capture daily or weekly caps, allowlists or exclusions, quiet hours, stop conditions, duplicate prevention, and what counts as a reply or conversion.
- For scheduled skills, include idempotency checks so a cron run does not repeat work already done in a previous run.
- For CRM writes, prefer additive updates with source attribution and confidence notes. Ask before overwriting existing user-authored fields unless I explicitly allow overwrites.

End by showing me the created skill path, how to invoke it manually, and the exact cron/scheduled message to use if the workflow should run on a schedule.`;
}
