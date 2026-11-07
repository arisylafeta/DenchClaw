---
company_id: "company-synthetic-3"
company: "Broken Fixture Ltd"
buyer_type: reseller
colour: red
origins: [Germany, D1]
min_soh: 120
needs_continuity: "yes"
timing:
  max_lead_days: 2.5
  window: soon
products:
  - format: crates
    chemistry: LCO
    status: maybe
    seen: "2026-13-40"
rules_out:
  chemistries: [LTO, "Lead acid"]
  damaged: "no"
alerts:
  - filters:
      format: [pack]
      seen: "not-a-date"
---
Body text.
