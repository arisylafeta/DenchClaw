import { createSkillTemplate, externalApps } from "./create-template";

export const fundraisingTargetBuilder = createSkillTemplate({
  id: "fundraising-target-builder",
  title: "Fundraising Target Builder",
  summary: "Build and maintain a prioritized investor target list for a fundraise.",
  category: "Run Founder Ops",
  outcome: "Maps investor fit, enriches partners, finds warm paths, ranks targets, and creates investor CRM records.",
  personas: ["Founder", "Investor/BD"],
  requiredApps: [externalApps.gmail, externalApps.notion],
  triggerModes: ["manual", "scheduled"],
  focusAreas: ["round details", "investor filters", "warm paths", "ranking criteria"],
});
