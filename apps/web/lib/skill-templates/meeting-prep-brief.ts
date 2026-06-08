import { createSkillTemplate, externalApps } from "./create-template";

export const meetingPrepBrief = createSkillTemplate({
  id: "meeting-prep-brief",
  title: "Meeting Prep Brief",
  summary: "Prepare concise briefs before sales, customer, partner, or recruiting calls.",
  category: "Prep Meetings",
  outcome: "Researches attendees, recent context, CRM history, open asks, risks, and recommended agenda before important meetings.",
  personas: ["Founder", "Sales", "Customer Success", "Investor/BD"],
  requiredApps: [externalApps.googleCalendar, externalApps.gmail],
  triggerModes: ["manual", "scheduled"],
  focusAreas: ["meeting types", "research depth", "brief timing", "sensitive topics"],
});
