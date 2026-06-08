import { createSkillTemplate, externalApps } from "./create-template";

export const investorUpdateBuilder = createSkillTemplate({
  id: "investor-update-builder",
  title: "Investor Update Builder",
  summary: "Draft crisp investor updates from company context, asks, and metrics.",
  category: "Run Founder Ops",
  outcome: "Gathers wins, metrics, asks, risks, and narrative context into a polished investor update draft or send-ready email.",
  personas: ["Founder", "Investor/BD"],
  requiredApps: [externalApps.gmail, externalApps.notion, externalApps.hubspot],
  triggerModes: ["manual", "scheduled"],
  focusAreas: ["audience", "sections", "source docs", "send policy"],
});
