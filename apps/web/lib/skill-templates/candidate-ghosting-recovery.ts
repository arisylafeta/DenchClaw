import { defineSkillTemplate, externalApps } from "./create-template";

export const candidateGhostingRecovery = defineSkillTemplate({
  id: "candidate-ghosting-recovery",
  title: "Candidate Ghosting Recovery",
  summary: "Detect stalled candidates and draft careful re-engagement without hurting candidate experience.",
  category: "Hire People",
  outcome: "Finds candidates who went quiet between stages, drafts stage-aware re-engagement, and pings the right hiring owner.",
  userUseCase:
    "Use when a recruiter or founder loses candidates between phone screens, onsite scheduling, offers, or follow-up steps and needs a respectful recovery motion. The skill should detect silence by stage, preserve candidate experience, and keep hiring managers informed without auto-sending sensitive messages.",
  personas: ["Recruiter", "Founder"],
  requiredApps: [externalApps.gmail, externalApps.googleCalendar, externalApps.notion],
  triggerModes: ["manual", "scheduled"],
  autonomy: "Creates drafts",
  interviewQuestions: [
    {
      id: "role-scope",
      prompt: "Which roles or candidate pipelines should be watched for ghosting?",
      required: true,
      freeformHint:
        "Name roles, stages, owners, candidate segments, excluded roles, or uploaded candidate views.",
    },
    {
      id: "ghosting-thresholds",
      prompt: "When should silence count as candidate ghosting by stage?",
      required: true,
      freeformHint:
        "Example: 72 hours after phone screen, 48 hours after onsite scheduling link, 24 hours after offer follow-up.",
    },
    {
      id: "recovery-action",
      prompt: "Which recovery actions should the skill prepare?",
      required: true,
      allowMultiple: true,
      options: [
        { id: "candidate-draft", label: "Candidate re-engagement draft" },
        { id: "hiring-manager-ping", label: "Hiring manager ping" },
        { id: "stage-cleanup", label: "Stage cleanup suggestion" },
        { id: "close-loop", label: "Close-loop recommendation" },
      ],
    },
    {
      id: "tone-policy",
      prompt: "What tone and candidate-experience guardrails should apply?",
      required: true,
      options: [
        { id: "warm-low-pressure", label: "Warm and low pressure" },
        { id: "direct-scheduling", label: "Direct scheduling ask" },
        { id: "value-add", label: "Add useful role context" },
        { id: "manual-only", label: "Manual owner review only" },
      ],
      freeformHint: "List phrases to avoid, rejection rules, and who must approve messages.",
    },
    {
      id: "owner-routing",
      prompt: "How should hiring managers or interviewers be notified?",
      required: true,
      freeformHint:
        "Include role channels, owners, escalation timing, and when the candidate should not be contacted again.",
    },
  ],
  skillInstructions: [
    "Detect ghosting from stage-specific silence across Dench CRM, Gmail threads, Calendar events, Notion scorecards, and uploaded ATS exports, not one universal timer; include the last candidate touch and expected next step.",
    "Before drafting, summarize candidate context, role stage, recent interaction, likely reason for silence if evidence exists, and recommended owner action.",
    "Keep all candidate-facing messages draft-only by default and never create rejection language unless explicitly requested.",
    "Reference only role-relevant, candidate-provided, or authorized context; avoid pressure, guilt, or assumptions about personal circumstances.",
    "Route hiring-manager prompts as concise decisions with candidate, stage, aging, blocker, and suggested action.",
    "For scheduled runs, suppress unchanged stalled candidates and resurface only when the SLA worsens or a new owner action is due.",
  ],
  activityLogInstructions: [
    "Append ghosting-recovery entries to the candidate record and hiring-owner action queue, keyed by role, stage, and silence threshold.",
    "Log last candidate touch, expected next step, days silent, recovery action prepared, hiring-manager ping, draft-only approval state, and next review date.",
    "Record candidate-experience safeguards and skip reasons such as do-not-contact, rejection pending, insufficient context, owner hold, personal-circumstance speculation risk, or unchanged stall.",
    "For scheduled runs, append only newly stalled candidates, SLA worsening, new owner actions due, drafts created, and candidates removed because they replied or stage changed.",
  ],
});
