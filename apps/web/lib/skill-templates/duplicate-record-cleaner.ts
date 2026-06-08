import { createSkillTemplate, externalApps } from "./create-template";

export const duplicateRecordCleaner = createSkillTemplate({
  id: "duplicate-record-cleaner",
  title: "Duplicate Record Cleaner",
  summary: "Find likely duplicate people or companies and prepare safe merge guidance.",
  category: "Keep CRM Clean",
  outcome: "Detects duplicate records, ranks merge confidence, proposes canonical records, and queues safe cleanup actions.",
  personas: ["RevOps", "Sales"],
  requiredApps: [externalApps.hubspot],
  triggerModes: ["manual", "scheduled"],
  focusAreas: ["duplicate signals", "canonical rules", "merge threshold", "audit log"],
});
