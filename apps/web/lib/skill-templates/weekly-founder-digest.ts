import { createSkillTemplate, externalApps } from "./create-template";

export const weeklyFounderDigest = createSkillTemplate({
  id: "weekly-founder-digest",
  title: "Weekly Founder Digest",
  summary: "Summarize the week across pipeline, customers, hiring, inbox, and priorities.",
  category: "Run Founder Ops",
  outcome: "Produces a weekly operating digest with wins, risks, asks, missed follow-ups, and priorities for the next week.",
  personas: ["Founder", "Operator"],
  requiredApps: [externalApps.gmail, externalApps.googleCalendar, externalApps.slack],
  triggerModes: ["scheduled", "manual"],
  focusAreas: ["operating areas", "weekly schedule", "important people", "task policy"],
});
