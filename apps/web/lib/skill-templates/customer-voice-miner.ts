import { createSkillTemplate, externalApps } from "./create-template";

export const customerVoiceMiner = createSkillTemplate({
  id: "customer-voice-miner",
  title: "Customer Voice Miner",
  summary: "Mine calls, notes, tickets, and messages for themes in customer language.",
  category: "Research Anything",
  outcome: "Extracts recurring pains, objections, feature requests, quotes, and messaging insights from customer-facing context.",
  personas: ["Founder", "Customer Success", "Sales"],
  requiredApps: [externalApps.slack, externalApps.notion],
  triggerModes: ["manual", "scheduled"],
  focusAreas: ["source set", "themes to mine", "quote rules", "destination"],
});
