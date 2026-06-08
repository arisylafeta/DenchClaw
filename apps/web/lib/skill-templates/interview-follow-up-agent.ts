import { createSkillTemplate, externalApps } from "./create-template";

export const interviewFollowUpAgent = createSkillTemplate({
  id: "interview-follow-up-agent",
  title: "Interview Follow-up Agent",
  summary: "Send timely candidate follow-ups and keep interview loops moving.",
  category: "Hire People",
  outcome: "Detects completed interviews, sends next-step messages, nudges interviewers, and updates candidate status.",
  personas: ["Recruiter", "Founder"],
  requiredApps: [externalApps.gmail, externalApps.googleCalendar],
  triggerModes: ["manual", "scheduled"],
  focusAreas: ["interview stages", "message policy", "internal nudges", "pipeline updates"],
});
