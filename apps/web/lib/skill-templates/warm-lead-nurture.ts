import { createSkillTemplate, externalApps } from "./create-template";

export const warmLeadNurture = createSkillTemplate({
  id: "warm-lead-nurture",
  title: "Warm Lead Nurture",
  summary: "Keep promising but not-ready leads warm with useful, low-pressure touches.",
  category: "Follow Up",
  outcome: "Segments warm leads, chooses relevant touchpoints, drafts or sends helpful check-ins, and logs future timing.",
  personas: ["Founder", "Sales"],
  requiredApps: [externalApps.gmail, externalApps.hubspot],
  triggerModes: ["manual", "scheduled"],
  focusAreas: ["warm lead definition", "nurture themes", "cadence", "conversion signals"],
});
