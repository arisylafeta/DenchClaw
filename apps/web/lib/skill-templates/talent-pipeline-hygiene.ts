import { createSkillTemplate, externalApps } from "./create-template";

export const talentPipelineHygiene = createSkillTemplate({
  id: "talent-pipeline-hygiene",
  title: "Talent Pipeline Hygiene",
  summary: "Find stale candidates, missing feedback, and broken hiring handoffs.",
  category: "Hire People",
  outcome: "Audits candidate pipelines, surfaces stale or incomplete records, and produces owner-specific cleanup actions.",
  personas: ["Recruiter", "Operator"],
  requiredApps: [externalApps.notion, externalApps.slack],
  triggerModes: ["manual", "scheduled"],
  focusAreas: ["pipeline source", "stale rules", "digest destination", "write policy"],
});
