import { createSkillTemplate } from "./create-template";

export const fundingSignalProspector = createSkillTemplate({
  id: "funding-signal-prospector",
  title: "Funding Signal Prospector",
  summary: "Find newly funded companies that match your ICP and likely need help now.",
  category: "Find Leads",
  outcome: "Monitors funding signals, filters against ICP rules, enriches contacts, and creates time-sensitive CRM opportunities.",
  personas: ["Founder", "Sales"],
  requiredApps: [],
  triggerModes: ["manual", "scheduled"],
  focusAreas: ["funding stages", "trigger thesis", "freshness window", "CRM handoff"],
});
