import { createSkillTemplate, externalApps } from "./create-template";

export const boardMeetingPrep = createSkillTemplate({
  id: "board-meeting-prep",
  title: "Board Meeting Prep",
  summary: "Assemble board prep packets, open questions, risks, and follow-up actions.",
  category: "Run Founder Ops",
  outcome: "Gathers metrics, narrative updates, decisions needed, risks, and prior commitments into a board-ready brief.",
  personas: ["Founder", "Operator"],
  requiredApps: [externalApps.googleCalendar, externalApps.gmail, externalApps.notion],
  triggerModes: ["manual", "scheduled"],
  focusAreas: ["meeting date", "required sections", "metrics source", "sensitive topics"],
});
