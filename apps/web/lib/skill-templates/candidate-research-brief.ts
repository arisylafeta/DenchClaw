import { createSkillTemplate, externalApps } from "./create-template";

export const candidateResearchBrief = createSkillTemplate({
  id: "candidate-research-brief",
  title: "Candidate Research Brief",
  summary: "Research candidates before outreach, interviews, or hiring debriefs.",
  category: "Hire People",
  outcome: "Creates candidate briefs with background, evidence, fit hypotheses, risks, and interview questions.",
  personas: ["Recruiter", "Founder"],
  requiredApps: [externalApps.linkedin, externalApps.github],
  triggerModes: ["manual"],
  focusAreas: ["role requirements", "source links", "privacy rules", "brief format"],
});
