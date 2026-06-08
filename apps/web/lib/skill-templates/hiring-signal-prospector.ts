import { createSkillTemplate } from "./create-template";

export const hiringSignalProspector = createSkillTemplate({
  id: "hiring-signal-prospector",
  title: "Hiring Signal Prospector",
  summary: "Spot companies hiring for roles that reveal urgency for your product.",
  category: "Find Leads",
  outcome: "Tracks hiring patterns, scores companies by pain intensity, enriches decision makers, and logs evidence-backed opportunities.",
  personas: ["Founder", "Sales"],
  requiredApps: [],
  triggerModes: ["manual", "scheduled"],
  focusAreas: ["job titles", "hiring thresholds", "decision-maker roles", "signal evidence"],
});
