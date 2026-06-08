import { createSkillTemplate, externalApps } from "./create-template";

export const recruitingOutreachBuilder = createSkillTemplate({
  id: "recruiting-outreach-builder",
  title: "Recruiting Outreach Builder",
  summary: "Create personalized candidate outreach with role-specific proof and guardrails.",
  category: "Hire People",
  outcome: "Researches candidates, drafts or sends role-specific messages, handles follow-ups, and logs candidate status.",
  personas: ["Recruiter", "Founder"],
  requiredApps: [externalApps.gmail, externalApps.linkedin],
  triggerModes: ["manual", "scheduled"],
  focusAreas: ["role pitch", "candidate persona", "send caps", "follow-up cadence"],
});
