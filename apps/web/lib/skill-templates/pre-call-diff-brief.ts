import { defineSkillTemplate, externalApps } from "./create-template";

export const preCallDiffBrief = defineSkillTemplate({
  id: "pre-call-diff-brief",
  title: "Pre-call Diff Brief",
  summary: "Deliver a tiny before-call brief focused on what changed since the last touch.",
  category: "Prep Meetings",
  outcome: "Creates a 60-second meeting brief with last touch, changes, open commitments, risks, and the next best ask.",
  userUseCase:
    "Use when a founder, seller, investor, recruiter, or CS owner has back-to-back meetings and needs a just-in-time brief that is shorter than a dossier. The skill should highlight only the facts that changed the meeting plan since the last interaction.",
  personas: ["Founder", "Sales", "Customer Success", "Recruiter", "Investor/BD"],
  requiredApps: [externalApps.googleCalendar, externalApps.gmail, externalApps.hubspot],
  triggerModes: ["manual", "scheduled"],
  autonomy: "Creates drafts",
  interviewQuestions: [
    {
      id: "meeting-scope",
      prompt: "Which meetings should receive a pre-call diff brief?",
      required: true,
      allowMultiple: true,
      options: [
        { id: "external-only", label: "External only" },
        { id: "customers", label: "Customers" },
        { id: "prospects", label: "Prospects" },
        { id: "investors", label: "Investors" },
        { id: "candidates", label: "Candidates" },
        { id: "manual-selection", label: "Manual selection" },
      ],
    },
    {
      id: "diff-sources",
      prompt: "Which context should count as a meaningful change?",
      required: true,
      allowMultiple: true,
      options: [
        { id: "last-conversation", label: "Last conversation" },
        { id: "email-thread", label: "Email thread" },
        { id: "crm-stage", label: "CRM or stage changes" },
        { id: "support-product", label: "Support or product updates" },
        { id: "news", label: "News or public signal" },
        { id: "internal-notes", label: "Internal notes" },
      ],
    },
    {
      id: "brief-shape",
      prompt: "What should the 60-second brief always include?",
      required: true,
      allowMultiple: true,
      options: [
        { id: "who", label: "Who and why now" },
        { id: "last-touch", label: "Last touch" },
        { id: "what-changed", label: "What changed" },
        { id: "open-commitments", label: "Open commitments" },
        { id: "recommended-ask", label: "Recommended ask" },
      ],
    },
    {
      id: "delivery-window",
      prompt: "When should the brief appear before the call?",
      required: true,
      options: [
        { id: "15-minutes", label: "15 minutes before" },
        { id: "30-minutes", label: "30 minutes before" },
        { id: "morning-of", label: "Morning of" },
        { id: "manual-only", label: "Manual only" },
      ],
    },
    {
      id: "length-policy",
      prompt: "What is the maximum length and sensitivity policy?",
      required: true,
      freeformHint:
        "Example: five bullets max, no scrolling, private section only for internal risks, low-confidence items hidden.",
    },
  ],
  skillInstructions: [
    "Anchor on the calendar event or selected meeting, then find the last meaningful interaction with the attendee, company, or opportunity.",
    "Use Gmail, HubSpot/Dench CRM, Calendar, enrichment, notes/files, and relevant public changes to lead with what changed since that last touch; skip static biography or company background unless it alters the recommended meeting plan.",
    "Keep the brief to the configured maximum length and put the recommended ask or CTA in the first screen.",
    "Separate commitments made by the user from commitments owed by the other party.",
    "Label sensitive internal context and low-confidence claims according to the configured visibility policy.",
    "For scheduled runs, regenerate only when meaningful context changes or the meeting is inside the delivery window.",
  ],
  activityLogInstructions: [
    "Append pre-call diff entries to the meeting brief artifact or calendar-attached note, keyed by meeting ID and delivery window.",
    "Log last meaningful touch, sources checked, changed facts included, commitments found, risks included or hidden, brief version, and recommended ask.",
    "Record skipped meetings with reasons such as no meaningful change, outside delivery window, sensitivity policy exclusion, or insufficient source confidence.",
    "For scheduled prep, append only regenerated briefs, newly changed context, delivery failures, and meetings intentionally suppressed since the previous scan.",
  ],
});
