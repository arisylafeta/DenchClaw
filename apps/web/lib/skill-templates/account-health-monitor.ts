import { createSkillTemplate, externalApps } from "./create-template";

export const accountHealthMonitor = createSkillTemplate({
  id: "account-health-monitor",
  title: "Account Health Monitor",
  summary: "Monitor accounts for risk, expansion signals, and missing next steps.",
  category: "Grow Customers",
  outcome: "Scores account health from CRM, email, meeting, and relationship signals, then alerts owners with recommended actions.",
  personas: ["Customer Success", "Founder"],
  requiredApps: [externalApps.hubspot, externalApps.gmail, externalApps.slack],
  triggerModes: ["scheduled", "manual"],
  focusAreas: ["account segments", "health signals", "risk thresholds", "owner alerts"],
});
