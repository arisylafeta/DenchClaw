import type {
  SkillTemplateApp,
  SkillTemplateCategory,
  SkillTemplateDefinition,
  SkillTemplateId,
  SkillTemplatePersona,
  SkillTemplateTriggerMode,
} from "./types";

export const externalApps = {
  gmail: { slug: "gmail", name: "Gmail" },
  googleCalendar: { slug: "google-calendar", name: "Google Calendar" },
  hubspot: { slug: "hubspot", name: "HubSpot" },
  notion: { slug: "notion", name: "Notion" },
  slack: { slug: "slack", name: "Slack" },
  github: { slug: "github", name: "GitHub" },
  linkedin: { slug: "linkedin", name: "LinkedIn" },
} satisfies Record<string, SkillTemplateApp>;

export type TemplateSeed = {
  id: SkillTemplateId;
  title: string;
  summary: string;
  category: SkillTemplateCategory;
  outcome: string;
  personas: readonly SkillTemplatePersona[];
  requiredApps: readonly SkillTemplateApp[];
  triggerModes: readonly SkillTemplateTriggerMode[];
  focusAreas: readonly string[];
};

const categoryInterviewTopics: Record<SkillTemplateCategory, readonly string[]> = {
  "Find Leads": ["where inputs should come from", "scoring and dedupe rules"],
  "Follow Up": ["message tone and approval policy", "stop conditions and reply detection"],
  "Keep CRM Clean": ["fields to update or protect", "confidence thresholds and audit notes"],
  "Prep Meetings": ["brief timing and destination", "meeting types and sensitive context"],
  "Research Anything": ["source rules and citation expectations", "output format and save destination"],
  "Hire People": ["role criteria and privacy guardrails", "pipeline update rules"],
  "Grow Customers": ["account segments and risk signals", "owner alerts and CRM updates"],
  "Run Founder Ops": ["cadence, audience, and delivery channel", "decisions, asks, and follow-up actions"],
};

const categoryInstructions: Record<SkillTemplateCategory, readonly string[]> = {
  "Find Leads": ["rank outputs with evidence, fit, timing, and confidence", "write CRM records additively with source URLs"],
  "Follow Up": ["use prior context before writing any message", "enforce caps, quiet hours, dedupe, and stop rules"],
  "Keep CRM Clean": ["preserve user-authored fields unless overwrite rules are explicit", "record confidence, source, and timestamp for every change"],
  "Prep Meetings": ["summarize context, objectives, risks, and recommended questions", "flag missing or low-confidence context clearly"],
  "Research Anything": ["separate verified facts from hypotheses", "end with recommendations and next research tasks"],
  "Hire People": ["avoid protected-class inference and cite professional evidence", "keep candidate communications stage-aware and respectful"],
  "Grow Customers": ["separate churn risk, expansion opportunity, and missing data", "alert owners only when action is warranted"],
  "Run Founder Ops": ["keep outputs concise, decision-oriented, and reusable", "make scheduled runs idempotent for the relevant period"],
};

export function createSkillTemplate(seed: TemplateSeed): SkillTemplateDefinition {
  return {
    ...seed,
    autonomy: "Can automate",
    interviewTopics: [
      ...seed.focusAreas.map((area) => "The exact " + area + " for this workflow."),
      ...categoryInterviewTopics[seed.category].map((topic) => "The " + topic + " to apply."),
    ].slice(0, 5),
    skillInstructions: [
      "A clear trigger description for when future agents should use " + seed.title + ".",
      "Step-by-step instructions to achieve this outcome: " + seed.outcome,
      ...categoryInstructions[seed.category],
      "Manual invocation guidance plus an exact cron/scheduled message when scheduled runs are enabled.",
    ],
  };
}
