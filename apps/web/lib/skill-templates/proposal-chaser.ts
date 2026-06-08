import { createSkillTemplate, externalApps } from "./create-template";

export const proposalChaser = createSkillTemplate({
  id: "proposal-chaser",
  title: "Proposal Chaser",
  summary: "Follow up on sent proposals without sounding desperate or repetitive.",
  category: "Follow Up",
  outcome: "Tracks sent proposals, detects stalled decisions, sends next-step nudges, and keeps forecast notes accurate.",
  personas: ["Founder", "Sales", "Investor/BD"],
  requiredApps: [externalApps.gmail, externalApps.hubspot],
  triggerModes: ["manual", "scheduled"],
  focusAreas: ["proposal status source", "decision timeline", "escalation path", "forecast updates"],
});
