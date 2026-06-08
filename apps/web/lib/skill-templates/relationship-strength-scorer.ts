import { createSkillTemplate, externalApps } from "./create-template";

export const relationshipStrengthScorer = createSkillTemplate({
  id: "relationship-strength-scorer",
  title: "Relationship Strength Scorer",
  summary: "Score relationships from recent emails, meetings, roles, and momentum.",
  category: "Keep CRM Clean",
  outcome: "Updates relationship strength, recency, confidence, and next-action fields across important contacts and accounts.",
  personas: ["Founder", "Sales", "Investor/BD", "RevOps"],
  requiredApps: [externalApps.gmail, externalApps.googleCalendar],
  triggerModes: ["manual", "scheduled"],
  focusAreas: ["scored segments", "signal weights", "score scale", "CRM fields"],
});
