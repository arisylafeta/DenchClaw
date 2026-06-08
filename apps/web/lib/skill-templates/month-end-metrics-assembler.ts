import { defineSkillTemplate, externalApps } from "./create-template";

export const monthEndMetricsAssembler = defineSkillTemplate({
  id: "month-end-metrics-assembler",
  title: "Month-end Metrics Assembler",
  summary: "Assemble founder-ready month-end metrics and deltas for updates, boards, and planning.",
  category: "Run Founder Ops",
  outcome: "Collects key monthly metrics, explains deltas, flags missing sources, and drafts a reusable metrics snapshot.",
  userUseCase:
    "Use when a founder spends hours pulling revenue, runway, customer, hiring, and forecast numbers into investor updates or board prep. The skill should assemble the numbers, show what changed, cite where each metric came from, and create the draft snapshot without assuming a large ops team.",
  personas: ["Founder", "Operator"],
  requiredApps: [externalApps.hubspot, externalApps.gmail, externalApps.notion],
  triggerModes: ["manual", "scheduled"],
  autonomy: "Creates drafts",
  interviewQuestions: [
    {
      id: "metric-scope",
      prompt: "Which month-end metrics should be assembled?",
      required: true,
      allowMultiple: true,
      options: [
        { id: "revenue", label: "Revenue and MRR" },
        { id: "runway", label: "Runway and burn" },
        { id: "pipeline", label: "Pipeline" },
        { id: "customers", label: "Customer progress" },
        { id: "hiring", label: "Hiring" },
        { id: "product", label: "Product usage or delivery" },
      ],
    },
    {
      id: "source-map",
      prompt: "Where does the founder currently keep each metric?",
      required: true,
      freeformHint:
        "Name files, tables, dashboards, docs, manual numbers, or pasted exports. Include the source of truth for each metric.",
    },
    {
      id: "delta-policy",
      prompt: "Which changes should be called out as meaningful?",
      required: true,
      freeformHint:
        "Example: any metric moving more than 5%, missed forecast, runway below 12 months, or customer conversion milestone.",
    },
    {
      id: "snapshot-audience",
      prompt: "Who will consume the metrics snapshot?",
      required: true,
      allowMultiple: true,
      options: [
        { id: "private-founder", label: "Private founder notes" },
        { id: "investors", label: "Investors" },
        { id: "board", label: "Board" },
        { id: "team", label: "Team" },
      ],
    },
    {
      id: "missing-data-policy",
      prompt: "How should missing or stale metrics be handled?",
      required: true,
      options: [
        { id: "flag-only", label: "Flag only" },
        { id: "ask-followup", label: "Ask me for missing values" },
        { id: "use-last-known", label: "Use last known with label" },
        { id: "omit", label: "Omit unsupported metrics" },
      ],
    },
  ],
  skillInstructions: [
    "Build a source map for every requested metric using HubSpot/Dench CRM, Gmail context, Notion/docs, uploaded spreadsheets, pasted numbers, and linked files; clearly separate verified values, user-provided values, stale values, and missing values.",
    "Calculate month-over-month and forecast deltas from source values or explicitly user-provided values only; otherwise flag the gap instead of inventing a number.",
    "Lead with the metrics that changed meaningfully and explain why each change matters for runway, fundraising, customer traction, or hiring.",
    "Create audience-specific versions only when requested; default to one private founder snapshot plus a concise update-ready summary.",
    "Cite or label the source of every metric, including HubSpot report/view, CRM field, Gmail thread, Notion page, uploaded file, or manual founder input, so the founder can answer investor or board follow-up questions.",
    "For scheduled runs, update the same period snapshot and track unresolved metric gaps until the founder fills or dismisses them.",
  ],
  activityLogInstructions: [
    "Append metrics assembly entries to the monthly snapshot document, keyed by reporting month, audience version, and source window.",
    "Log metrics requested, source-of-truth map, values verified, values stale or user-provided, deltas calculated, missing metrics, and audience versions created.",
    "Record every unresolved gap with owner, source expected, last-known value if used, confidence label, and whether the founder was asked or the metric was omitted.",
    "For scheduled month-end runs, log only changed values, resolved gaps, newly missing metrics, and updates to the same period snapshot rather than duplicate drafts.",
  ],
});
