import { createSkillTemplate, externalApps } from "./create-template";

export const investorMeetingPrep = createSkillTemplate({
  id: "investor-meeting-prep",
  title: "Investor Meeting Prep",
  summary: "Research investors and assemble a sharp brief before fundraising meetings.",
  category: "Prep Meetings",
  outcome: "Researches investor background, portfolio, thesis, prior interactions, likely objections, and tailored talking points.",
  personas: ["Founder", "Investor/BD"],
  requiredApps: [externalApps.googleCalendar, externalApps.gmail, externalApps.notion],
  triggerModes: ["manual", "scheduled"],
  focusAreas: ["investor goal", "company narrative", "portfolio fit", "follow-up rules"],
});
