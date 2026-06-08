import { createSkillTemplate, externalApps } from "./create-template";

export const linkedinStyleOutreach = createSkillTemplate({
  id: "linkedin-style-outreach",
  title: "LinkedIn-style Outreach",
  summary: "Create concise social-style outreach and follow-ups with strict automation rules.",
  category: "Follow Up",
  outcome: "Researches prospects, writes short LinkedIn-style messages, manages follow-up sequencing, and logs outreach state.",
  personas: ["Founder", "Sales", "Recruiter"],
  requiredApps: [externalApps.linkedin],
  triggerModes: ["manual", "scheduled"],
  focusAreas: ["audience source", "channel constraints", "message style", "automation caps"],
});
