import { createSkillTemplate, externalApps } from "./create-template";

export const icpOutreachBuilder = createSkillTemplate({
  id: "icp-outreach-builder",
  title: "ICP Outreach Builder",
  summary: "Build a guardrailed outbound skill from an ICP, offer, and send policy.",
  category: "Find Leads",
  outcome: "Researches ICP-matched leads, writes personalized messages, follows the configured send policy, and logs activity to CRM.",
  personas: ["Founder", "Sales"],
  requiredApps: [externalApps.gmail, externalApps.hubspot],
  triggerModes: ["manual", "scheduled"],
  focusAreas: ["ICP and buyer persona", "offer and CTA", "send rules", "follow-up cadence"],
});
