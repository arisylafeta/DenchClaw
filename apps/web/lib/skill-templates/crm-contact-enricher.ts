import { createSkillTemplate, externalApps } from "./create-template";

export const crmContactEnricher = createSkillTemplate({
  id: "crm-contact-enricher",
  title: "CRM Contact Enricher",
  summary: "Fill missing contact and company fields with attributed enrichment.",
  category: "Keep CRM Clean",
  outcome: "Finds incomplete records, enriches missing fields from native data and external CRM context, and writes confidence-scored updates.",
  personas: ["RevOps", "Sales"],
  requiredApps: [externalApps.hubspot],
  triggerModes: ["manual", "scheduled"],
  focusAreas: ["record segments", "required fields", "confidence threshold", "overwrite rules"],
});
