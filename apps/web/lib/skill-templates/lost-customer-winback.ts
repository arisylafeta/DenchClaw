import { createSkillTemplate, externalApps } from "./create-template";

export const lostCustomerWinback = createSkillTemplate({
  id: "lost-customer-winback",
  title: "Lost Customer Winback",
  summary: "Identify lost customers worth re-engaging and craft high-signal winback plays.",
  category: "Grow Customers",
  outcome: "Segments churned or closed-lost accounts, finds reactivation triggers, sends winback messages, and logs outcomes.",
  personas: ["Founder", "Customer Success", "Sales"],
  requiredApps: [externalApps.gmail, externalApps.hubspot],
  triggerModes: ["manual", "scheduled"],
  focusAreas: ["qualified lost accounts", "churn reasons", "new proof points", "contact rules"],
});
