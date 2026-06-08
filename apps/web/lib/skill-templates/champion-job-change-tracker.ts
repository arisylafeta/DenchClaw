import { defineSkillTemplate, externalApps } from "./create-template";

export const championJobChangeTracker = defineSkillTemplate({
  id: "champion-job-change-tracker",
  title: "Champion Job-change Tracker",
  summary: "Catch champions who move roles and turn the change into a relationship-safe action plan.",
  category: "Grow Customers",
  outcome: "Detects champion role changes, assesses risk or new-account potential, drafts owner-reviewed outreach, and creates account follow-up actions.",
  userUseCase:
    "Use when a sales, founder, or customer-success owner depends on champions and needs a repeatable way to catch job changes before renewals, expansions, or referrals go cold. The skill should protect the existing account relationship, identify the champion's new company fit, and draft personal follow-up for review.",
  personas: ["Customer Success", "Sales", "Founder"],
  requiredApps: [externalApps.hubspot, externalApps.gmail],
  triggerModes: ["manual", "scheduled"],
  autonomy: "Creates drafts",
  interviewQuestions: [
    {
      id: "champion-scope",
      prompt: "Which champions or accounts should be monitored for role changes?",
      required: true,
      freeformHint:
        "Name account segments, contact roles, relationship strength thresholds, renewal windows, or uploaded contact lists.",
    },
    {
      id: "change-signals",
      prompt: "Which signals should count as evidence that a champion moved?",
      required: true,
      allowMultiple: true,
      options: [
        { id: "profile-change", label: "Public profile change" },
        { id: "email-bounce", label: "Email bounce or OOO" },
        { id: "crm-title-change", label: "CRM title/account change" },
        { id: "manual-list", label: "Manual review list" },
      ],
    },
    {
      id: "account-risk-policy",
      prompt: "How should the skill handle the old account when a champion leaves?",
      required: true,
      allowMultiple: true,
      options: [
        { id: "find-new-champion", label: "Find likely replacement champion" },
        { id: "renewal-risk", label: "Flag renewal risk" },
        { id: "owner-task", label: "Create owner task" },
        { id: "do-not-alert", label: "Do not alert unless renewal is near" },
      ],
    },
    {
      id: "new-company-policy",
      prompt: "What should happen at the champion's new company?",
      required: true,
      allowMultiple: true,
      options: [
        { id: "fit-brief", label: "Build fit brief" },
        { id: "personal-draft", label: "Draft personal note" },
        { id: "crm-opportunity", label: "Suggest opportunity" },
        { id: "watch-only", label: "Watch only" },
      ],
    },
    {
      id: "message-guardrails",
      prompt: "What tone, approval, and no-go rules should apply to champion outreach?",
      required: true,
      freeformHint:
        "Include draft-only rules, phrases to avoid, whether to mention the old account, and who must approve sends.",
    },
  ],
  skillInstructions: [
    "Identify likely champion role changes from HubSpot/Dench CRM contact changes, Gmail bounces or OOO replies, Dench-native enrichment, public profile/web evidence, and uploaded review lists; separate confirmed changes from weak hints.",
    "For the old account, summarize why the champion mattered, open renewal or expansion exposure, likely replacement contacts, and the recommended owner action.",
    "For the champion's new company, use enrichment, CRM ownership, prior Gmail relationship history, and public account evidence to assess fit, timing, account ownership, and relationship context before suggesting outreach.",
    "Draft personal follow-up that reads like a relationship note, not a marketing reactivation email, and never auto-send by default.",
    "Avoid implying private knowledge, sensitive employment details, or pressure around the role change.",
    "For scheduled runs, suppress unchanged champion changes and resurface only when risk, fit, or owner action materially changes.",
  ],
  activityLogInstructions: [
    "Append champion-change entries to both the old account record and the champion/contact relationship note, with a separate new-company brief when applicable.",
    "Log change evidence, confirmation status, old account risk, replacement-champion search, new company fit, draft created, owner routed, and approval state.",
    "Record skipped or watch-only decisions with reasons such as weak evidence, no renewal exposure, poor new-company fit, sensitive context, or owner hold.",
    "For scheduled monitoring, log only confirmed changes, risk/fit changes, new owner actions due, and previously surfaced changes that were resolved.",
  ],
});
