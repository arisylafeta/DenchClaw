import { createSkillTemplate, externalApps } from "./create-template";

export const staleThreadFollowUpAgent = createSkillTemplate({
  id: "stale-thread-follow-up-agent",
  title: "Stale Thread Follow-up Agent",
  summary: "Find valuable email threads that went quiet and revive them safely.",
  category: "Follow Up",
  outcome: "Scans stale conversations, ranks which deserve action, drafts or sends tasteful nudges, and updates CRM status.",
  personas: ["Founder", "Sales", "Customer Success"],
  requiredApps: [externalApps.gmail, externalApps.hubspot],
  triggerModes: ["manual", "scheduled"],
  focusAreas: ["stale thresholds", "valuable threads", "tone and CTA", "reply detection"],
});
