import { createSkillTemplate, externalApps } from "./create-template";

export const partnerPipelineBuilder = createSkillTemplate({
  id: "partner-pipeline-builder",
  title: "Partner Pipeline Builder",
  summary: "Build a partner pipeline with fit scoring, relationship paths, and next steps.",
  category: "Run Founder Ops",
  outcome: "Discovers potential partners, scores mutual value, identifies contacts and warm paths, and logs pipeline records.",
  personas: ["Founder", "Investor/BD", "Sales"],
  requiredApps: [externalApps.gmail, externalApps.hubspot],
  triggerModes: ["manual", "scheduled"],
  focusAreas: ["partner type", "mutual value", "relationship paths", "stage fields"],
});
