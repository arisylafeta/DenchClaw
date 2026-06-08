import { createSkillTemplate, externalApps } from "./create-template";

export const executiveDailyBrief = createSkillTemplate({
  id: "executive-daily-brief",
  title: "Executive Daily Brief",
  summary: "Start each day with priorities, meetings, follow-ups, and lurking risks.",
  category: "Prep Meetings",
  outcome: "Reviews calendar, inbox, Slack, CRM, and workspace context to produce a focused daily plan.",
  personas: ["Founder", "Operator", "Knowledge Worker"],
  requiredApps: [externalApps.googleCalendar, externalApps.gmail, externalApps.slack],
  triggerModes: ["scheduled", "manual"],
  focusAreas: ["delivery time", "priority sources", "urgency rules", "task policy"],
});
