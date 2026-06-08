import { createSkillTemplate, externalApps } from "./create-template";

export const marketMapBuilder = createSkillTemplate({
  id: "market-map-builder",
  title: "Market Map Builder",
  summary: "Map a market into segments, players, signals, and open opportunities.",
  category: "Research Anything",
  outcome: "Builds and updates a market map with categories, companies, trends, funding, customer segments, and strategic takeaways.",
  personas: ["Founder", "Investor/BD", "Knowledge Worker"],
  requiredApps: [externalApps.notion],
  triggerModes: ["manual"],
  focusAreas: ["market boundaries", "segmentation", "signals", "save location"],
});
