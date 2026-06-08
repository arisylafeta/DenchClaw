import { createSkillTemplate } from "./create-template";

export const companyDeepResearcher = createSkillTemplate({
  id: "company-deep-researcher",
  title: "Company Deep Researcher",
  summary: "Create a sourced company dossier for sales, hiring, investing, or strategy.",
  category: "Research Anything",
  outcome: "Builds a sourced company brief with business model, team, market, recent news, risks, and recommended actions.",
  personas: ["Founder", "Sales", "Investor/BD", "Knowledge Worker"],
  requiredApps: [],
  triggerModes: ["manual"],
  focusAreas: ["research purpose", "sections needed", "source rules", "output format"],
});
