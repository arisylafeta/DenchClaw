import { createSkillTemplate } from "./create-template";

export const targetAccountListBuilder = createSkillTemplate({
  id: "target-account-list-builder",
  title: "Target Account List Builder",
  summary: "Turn an ICP into a ranked account list with contacts, evidence, and next actions.",
  category: "Find Leads",
  outcome: "Discovers target companies, enriches contacts, scores fit, and writes a prioritized list into Dench CRM.",
  personas: ["Founder", "Sales"],
  requiredApps: [],
  triggerModes: ["manual", "scheduled"],
  focusAreas: ["ICP filters and exclusions", "lead sources", "ranking rubric", "CRM output fields"],
});
