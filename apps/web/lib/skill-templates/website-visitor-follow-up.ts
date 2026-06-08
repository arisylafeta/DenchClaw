import { createSkillTemplate, externalApps } from "./create-template";

export const websiteVisitorFollowUp = createSkillTemplate({
  id: "website-visitor-follow-up",
  title: "Website Visitor Follow-up",
  summary: "Turn a pasted or synced visitor list into prioritized follow-up tasks and messages.",
  category: "Find Leads",
  outcome: "Accepts visitor or intent exports, matches accounts, prioritizes warm leads, drafts follow-ups, and logs next actions.",
  personas: ["Founder", "Sales"],
  requiredApps: [externalApps.gmail],
  triggerModes: ["manual", "scheduled"],
  focusAreas: ["visitor data source", "priority pages", "matching rules", "send policy"],
});
