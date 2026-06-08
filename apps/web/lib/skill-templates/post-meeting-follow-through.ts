import { createSkillTemplate, externalApps } from "./create-template";

export const postMeetingFollowThrough = createSkillTemplate({
  id: "post-meeting-follow-through",
  title: "Post-meeting Follow-through",
  summary: "Turn meeting notes into follow-ups, CRM updates, and owner-specific tasks.",
  category: "Prep Meetings",
  outcome: "Summarizes meeting outcomes, drafts or sends next-step emails, updates CRM, and creates scheduled reminders.",
  personas: ["Founder", "Sales", "Customer Success", "Recruiter"],
  requiredApps: [externalApps.googleCalendar, externalApps.gmail, externalApps.hubspot],
  triggerModes: ["manual", "scheduled"],
  focusAreas: ["meeting types", "notes source", "follow-up SLA", "CRM updates"],
});
