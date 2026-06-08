import { createSkillTemplate, externalApps } from "./create-template";

export const lookalikeCustomerFinder = createSkillTemplate({
  id: "lookalike-customer-finder",
  title: "Lookalike Customer Finder",
  summary: "Use best customers as seeds to find companies that look and behave like them.",
  category: "Find Leads",
  outcome: "Analyzes customer seeds, extracts fit patterns, discovers lookalike accounts, and creates a ranked prospect list.",
  personas: ["Founder", "Sales", "RevOps"],
  requiredApps: [externalApps.hubspot],
  triggerModes: ["manual", "scheduled"],
  focusAreas: ["seed customers", "match signals", "output size", "dedupe policy"],
});
