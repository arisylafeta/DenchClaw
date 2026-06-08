import { createSkillTemplate, externalApps } from "./create-template";

export const renewalRiskDigest = createSkillTemplate({
  id: "renewal-risk-digest",
  title: "Renewal Risk Digest",
  summary: "Surface upcoming renewals with risk signals and action plans.",
  category: "Grow Customers",
  outcome: "Reviews accounts approaching renewal, identifies risks and champions, drafts owner actions, and logs readiness notes.",
  personas: ["Customer Success", "Sales", "Founder"],
  requiredApps: [externalApps.hubspot, externalApps.gmail, externalApps.slack],
  triggerModes: ["scheduled", "manual"],
  focusAreas: ["renewal window", "risk signals", "champion signals", "digest cadence"],
});
