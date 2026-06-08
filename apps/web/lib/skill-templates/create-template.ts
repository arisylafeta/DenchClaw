import type {
  SkillTemplateApp,
  SkillTemplateCategory,
  SkillTemplateDefinition,
  SkillTemplateDefinitionInput,
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

const customerValidatedInstructions = [
  "Treat Dench CRM, connected Gmail, connected HubSpot, uploaded files/manual exports, web research, and Dench-native enrichment as available source primitives; only mark a capability unavailable when the specific user data or permission is missing.",
  "Start from the user's current pressure and produce a ranked action queue before any long narrative; if the run produces a brief, cap the first section to the smallest useful skim.",
  "Default external communication and data writes to draft or review unless the skill instructions and the user's answers clearly authorize a narrow automated action.",
  "Attach evidence, confidence, missing-data caveats, and recommended next owner action to every scored lead, risk, cleanup suggestion, follow-up, or brief section.",
  "Ask the fewest setup questions needed, infer sane defaults from the selected template, and let the user override details later instead of front-loading configuration.",
  "For scheduled runs, suppress unchanged findings and explain what changed since the last run or last touchpoint before repeating a recommendation.",
] as const;

const categoryValidatedInstructions: Record<SkillTemplateCategory, readonly string[]> = {
  "Find Leads": [
    "Prioritize signal-backed opportunities over raw account volume; include disqualifiers, why-now rationale, and draft-only personalized outreach angles for each top lead.",
  ],
  "Follow Up": [
    "Differentiate champions, economic buyers, operators, and internal owners before drafting follow-up; keep follow-up sequences short and avoid generic checking-in language.",
  ],
  "Keep CRM Clean": [
    "Treat CRM mutations as high-risk: provide dry-run output, before/after diffs, audit reasons, manual-edit preservation, and approval gates before any bulk write.",
  ],
  "Prep Meetings": [
    "Lead with a 60-second skim: who, last touch, open asks, what changed, and the recommended CTA; demote static background unless it changes the meeting plan.",
  ],
  "Research Anything": [
    "Use source-quality tiers, prefer primary sources, cite exact support for material claims, and mark unverifiable claims as unable to verify instead of filling gaps.",
  ],
  "Hire People": [
    "Protect candidate experience: keep candidate-facing communication draft-only, respect stage-specific context, and route hiring-manager actions as concise decision prompts.",
  ],
  "Grow Customers": [
    "Surface anomaly-backed customer risks and expansion plays with evidence trails and CSM-led talk tracks; never turn relationship-sensitive guidance into auto-sent customer email by default.",
  ],
  "Run Founder Ops": [
    "Optimize for solo-founder time: avoid assumed teams or CRMs, write the actual draft or decision artifact, and call out missing business metrics instead of producing fill-in-the-blank templates.",
  ],
};

const sharedActivityLogInstructions = [
  "Use timestamped activity log entries that name the trigger source, run window, records or artifacts touched, evidence used, decisions made, and next owner action.",
  "For scheduled runs, log what changed since the prior run and suppress unchanged findings instead of repeating the same entry.",
  "Keep logs privacy-safe: include enough evidence for auditability, but omit sensitive message bodies, protected-class data, and unsupported guesses.",
] as const;

const categorySuggestedApps: Record<SkillTemplateCategory, readonly SkillTemplateApp[]> = {
  "Find Leads": [
    externalApps.gmail,
    externalApps.hubspot,
    externalApps.linkedin,
  ],
  "Follow Up": [
    externalApps.gmail,
    externalApps.hubspot,
    externalApps.googleCalendar,
  ],
  "Keep CRM Clean": [
    externalApps.hubspot,
    externalApps.gmail,
    externalApps.slack,
  ],
  "Prep Meetings": [
    externalApps.googleCalendar,
    externalApps.gmail,
    externalApps.hubspot,
    externalApps.notion,
  ],
  "Research Anything": [
    externalApps.notion,
    externalApps.slack,
    externalApps.gmail,
    externalApps.linkedin,
    externalApps.github,
  ],
  "Hire People": [
    externalApps.linkedin,
    externalApps.gmail,
    externalApps.googleCalendar,
    externalApps.notion,
    externalApps.github,
  ],
  "Grow Customers": [
    externalApps.hubspot,
    externalApps.gmail,
    externalApps.slack,
    externalApps.googleCalendar,
  ],
  "Run Founder Ops": [
    externalApps.gmail,
    externalApps.googleCalendar,
    externalApps.notion,
    externalApps.slack,
    externalApps.hubspot,
  ],
};

function dedupeApps(apps: readonly SkillTemplateApp[]): readonly SkillTemplateApp[] {
  const seen = new Set<string>();
  return apps.filter((app) => {
    if (seen.has(app.slug)) {
      return false;
    }
    seen.add(app.slug);
    return true;
  });
}

export function defineSkillTemplate(
  template: SkillTemplateDefinitionInput,
): SkillTemplateDefinition {
  return {
    ...template,
    suggestedApps: dedupeApps(
      template.suggestedApps ?? [
        ...template.requiredApps,
        ...categorySuggestedApps[template.category],
      ],
    ),
    skillInstructions: [
      ...template.skillInstructions,
      ...customerValidatedInstructions,
      ...categoryValidatedInstructions[template.category],
    ],
    activityLogInstructions: [
      ...template.activityLogInstructions,
      ...sharedActivityLogInstructions,
    ],
  };
}
