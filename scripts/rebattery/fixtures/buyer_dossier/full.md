---
company_id: "company-synthetic-1"
company: "Synthetic Modules Ltd"
buyer_type: module_builder
intent: [reuse, cells]
countries: [DE, NL]
needs_continuity: true
origins: ["Passenger EV", "bus or truck"]
source_countries: [DE, PL, "cz"]
min_soh: 60
products:
  - platform: MEB
    make: Volkswagen
    model: ID.4
    format: packs
    chemistry: NMC
    kwh: [82]
    part_number: 5WA915233
    status: bought
    seen: "2026-06-15"
    src: "gmail_msg_fixture1"
  - make: "MG, Stellantis, Tesla"
    format: packs
    chemistry: LFP
    kwh: [40, 60]
    status: asked
    seen: "2026-07-01"
    src: "whatsapp:message:fixture2"
  - make: "Stellantis / FPT / Kokam"
    format: modules
    chemistry: NMC
    kwh: [2.6]
    module_series: "ZEN 35"
    status: said_interested
  - make: Tesla
    format: packs
    chemistry: NMC
    kwh: [75]
    status: declined
    seen: "2026-01-10"
    src: "gmail_msg_fixture3"
  - make: Stellantis
    format: packs
    chemistry: NMC
    kwh_min: 30
    module_series: "e-CMP"
    status: asked
    seen: "2026-08-02"
    src: "gmail_msg_fixture6"
rules_out:
  chemistries:
    - LTO
    - value: Lead-acid
      seen: "2026-05-02"
      src: "gmail_msg_fixture4"
  formats:
    - Systems
  damaged: true
  bess_systems: true
  other:
    - "no unknown provenance"
    - value: "no cells below 50% SoH"
      seen: "2026-06-30"
      src: "call:fixture5"
substitution:
  kwh_tolerance: 0.15
  same_platform_other_make: true
price:
  - eur_per_kwh: 30
    basis: paid
    seen: "2026-06-15"
    src: "gmail_msg_fixture1"
  - eur_per_unit: 900
    currency_original: GBP
    basis: quoted_by_buyer
    seen: "2026-07-01"
    src: "whatsapp:message:fixture2"
evidence_required:
  - tested_soh
  - value: bms_data
    seen: "2026-06-15"
    src: "gmail_msg_fixture1"
quantity:
  min_units: 2
  typical_units: 10
  cadence: standing
  whole_batch_ok: true
logistics:
  collects: own_haulier
  notes: "Own ADR transport from anywhere in the EU."
capability:
  notes: "Dismantles packs to modules in house."
decision_speed: fast
timing:
  max_lead_days: 30
  notes: "Needs stock inside a month once a purchase order is raised."
last_verified: "2026-07-02"
conflicts:
  - "Two pack capacities were quoted in June; the 82 kWh MEB figure is the one they bought."
alerts:
  - label: "LFP packs under 60 kWh"
    filters:
      chemistry: [LFP]
      format: [pack]
      kwh_max: 60
    status: active
    seen: "2026-07-01"
    src: "saved_search:fixture6"
---
## What they buy

Second-life MEB packs, stripped to modules for stationary cabinets.

## Notes

Never takes damaged stock.
