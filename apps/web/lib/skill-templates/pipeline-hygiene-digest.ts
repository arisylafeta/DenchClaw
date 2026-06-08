import { createSkillTemplate, externalApps } from "./create-template";

export const pipelineHygieneDigest = createSkillTemplate({
  id: "pipeline-hygiene-digest",
  title: "Pipeline Hygiene Digest",
  summary: "Send a digest of stale deals, missing next steps, and risky CRM gaps.",
  category: "Keep CRM Clean",
  outcome: "Audits pipeline records, surfaces the highest-impact hygiene issues, and posts action-oriented cleanup recommendations.",
  personas: ["Founder", "Sales", "RevOps"],
  requiredApps: [externalApps.hubspot, externalApps.slack],
  triggerModes: ["manual", "scheduled"],
  focusAreas: ["pipeline stages", "stale thresholds", "digest destination", "write permissions"],
});
