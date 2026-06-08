import { createSkillTemplate, externalApps } from "./create-template";

export const noShowRecovery = createSkillTemplate({
  id: "no-show-recovery",
  title: "No-show Recovery",
  summary: "Recover missed meetings with fast, polite rescheduling and CRM notes.",
  category: "Follow Up",
  outcome: "Identifies no-shows, sends rescheduling notes, updates CRM/calendar context, and stops when a new meeting is booked.",
  personas: ["Founder", "Sales", "Customer Success", "Recruiter"],
  requiredApps: [externalApps.gmail, externalApps.googleCalendar],
  triggerModes: ["manual", "scheduled"],
  focusAreas: ["meeting types", "follow-up timing", "reschedule options", "retry limits"],
});
