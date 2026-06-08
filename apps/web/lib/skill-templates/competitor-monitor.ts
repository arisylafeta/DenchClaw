import { createSkillTemplate, externalApps } from "./create-template";

export const competitorMonitor = createSkillTemplate({
  id: "competitor-monitor",
  title: "Competitor Monitor",
  summary: "Monitor competitor launches, pricing changes, messaging, and market moves.",
  category: "Research Anything",
  outcome: "Tracks named competitors, summarizes meaningful changes, and posts implications with suggested responses.",
  personas: ["Founder", "Sales", "Customer Success"],
  requiredApps: [externalApps.slack],
  triggerModes: ["scheduled", "manual"],
  focusAreas: ["competitor list", "signal types", "digest cadence", "noise filters"],
});
