import { createSkillTemplate, externalApps } from "./create-template";

export const hiringManagerWeeklyDigest = createSkillTemplate({
  id: "hiring-manager-weekly-digest",
  title: "Hiring Manager Weekly Digest",
  summary: "Send hiring managers a weekly summary of pipeline health and decisions needed.",
  category: "Hire People",
  outcome: "Summarizes candidates, interviews, feedback gaps, risks, and decisions required by each hiring manager.",
  personas: ["Recruiter", "Founder", "Operator"],
  requiredApps: [externalApps.googleCalendar, externalApps.slack, externalApps.notion],
  triggerModes: ["scheduled", "manual"],
  focusAreas: ["roles covered", "weekly sections", "escalation rules", "delivery channel"],
});
