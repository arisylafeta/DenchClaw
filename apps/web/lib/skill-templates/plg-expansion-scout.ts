import { defineSkillTemplate, externalApps } from "./create-template";

export const plgExpansionScout = defineSkillTemplate({
  id: "plg-expansion-scout",
  title: "PLG Expansion Scout",
  summary: "Find product-led expansion moments and turn them into CSM-led talk tracks.",
  category: "Grow Customers",
  outcome: "Surfaces account-level expansion signals, explains why they matter, and drafts owner-reviewed consolidation or upsell plays.",
  userUseCase:
    "Use when a PLG or hybrid sales team has product usage inside existing customer organizations and needs to spot expansion without sounding like vendor spam. The skill should group usage into account context, identify real expansion moments, and give CSMs a talk track rather than auto-emailing customers.",
  personas: ["Customer Success", "Sales", "Founder"],
  requiredApps: [externalApps.hubspot, externalApps.gmail],
  triggerModes: ["manual", "scheduled"],
  autonomy: "Creates drafts",
  interviewQuestions: [
    {
      id: "account-scope",
      prompt: "Which customer accounts or workspace segments should be scanned for expansion signals?",
      required: true,
      freeformHint:
        "Name paid accounts, free workspaces inside paid orgs, plan tiers, ownership rules, or uploaded usage exports.",
    },
    {
      id: "expansion-signals",
      prompt: "Which product-led signals should count as expansion-worthy?",
      required: true,
      allowMultiple: true,
      options: [
        { id: "seat-growth", label: "Seat growth" },
        { id: "usage-spike", label: "Usage spike" },
        { id: "new-team", label: "New team or department" },
        { id: "feature-depth", label: "High-value feature adoption" },
        { id: "free-in-paid-org", label: "Free workspace in paid org" },
        { id: "integration-interest", label: "Integration interest" },
      ],
    },
    {
      id: "noise-floor",
      prompt: "What should the skill suppress as normal noise?",
      required: true,
      freeformHint:
        "Include minimum seat or usage thresholds, repeat-signal suppression, quiet accounts, and excluded teams.",
    },
    {
      id: "owner-play",
      prompt: "What output should the account owner get for each expansion signal?",
      required: true,
      allowMultiple: true,
      options: [
        { id: "talk-track", label: "CSM talk track" },
        { id: "account-brief", label: "Account brief" },
        { id: "draft-note", label: "Draft owner-reviewed note" },
        { id: "task", label: "Owner task" },
      ],
    },
    {
      id: "relationship-policy",
      prompt: "What relationship guardrails should apply before any customer touch?",
      required: true,
      freeformHint:
        "Include draft-only rules, who owns the relationship, approved language, and when expansion should not be pursued.",
    },
  ],
  skillInstructions: [
    "Accept product usage from uploaded exports, pasted tables, saved reports, HubSpot properties, CRM notes, or workspace lists, then group each signal to the correct customer account before recommending expansion; flag uncertain account mapping as missing data.",
    "Rank expansion signals by evidence strength, account value, relationship context, and urgency instead of surfacing every usage increase.",
    "Use HubSpot/Dench CRM ownership, Gmail relationship history, enrichment, and account notes to explain the exact behavior that changed and why it creates a plausible expansion conversation.",
    "Produce CSM-led talk tracks and owner-reviewed drafts; never auto-send customer-facing expansion outreach by default.",
    "Separate expansion opportunity from renewal risk so owners can decide whether to sell, nurture, or protect the relationship.",
    "For scheduled runs, suppress unchanged signals and resurface only when the signal crosses a new threshold or owner action becomes due.",
  ],
  activityLogInstructions: [
    "Append PLG expansion entries to the customer account note or expansion-signal digest, keyed by account, workspace segment, and signal window.",
    "Log usage source, account mapping confidence, signal threshold crossed, behavior changed, expansion versus renewal-risk classification, owner play, and draft/task created.",
    "Capture suppressed signals with reason: below noise floor, uncertain account mapping, unchanged threshold, relationship guardrail, or owner hold.",
    "For scheduled runs, append only new threshold crossings, materially changed usage, owner actions due, and expansion signals resolved or dismissed.",
  ],
});
