import { createSkillTemplate, externalApps } from "./create-template";

export const newsSignalDigest = createSkillTemplate({
  id: "news-signal-digest",
  title: "News Signal Digest",
  summary: "Turn noisy news into a short digest of actionable signals.",
  category: "Research Anything",
  outcome: "Watches topics, companies, people, and markets, then posts relevant developments with context and next actions.",
  personas: ["Founder", "Sales", "Investor/BD", "Knowledge Worker"],
  requiredApps: [externalApps.slack],
  triggerModes: ["scheduled", "manual"],
  focusAreas: ["watch topics", "action threshold", "digest style", "task policy"],
});
