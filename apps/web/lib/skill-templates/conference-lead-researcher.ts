import { createSkillTemplate, externalApps } from "./create-template";

export const conferenceLeadResearcher = createSkillTemplate({
  id: "conference-lead-researcher",
  title: "Conference Lead Researcher",
  summary: "Research attendees, speakers, or sponsors before an event and build a hit list.",
  category: "Find Leads",
  outcome: "Turns an event or attendee list into a prioritized meeting and outreach plan with CRM-ready context.",
  personas: ["Founder", "Sales", "Investor/BD"],
  requiredApps: [externalApps.gmail, externalApps.googleCalendar],
  triggerModes: ["manual"],
  focusAreas: ["event source", "target persona", "meeting value", "output format"],
});
