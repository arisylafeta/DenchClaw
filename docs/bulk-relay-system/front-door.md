# Front door: size, route, qualified

For Ari, 12 Nov 2026. What slice 2 adds (migration `117_relay_front_door.sql`, `apps/web/lib/relay-front-door.ts`, `relay-deal.ts`, `relay-deal-core.ts`) and the rules as coded. The rules live in one module, `relay-front-door.ts`; the SQL twin is in 117 and a test keeps the two in step.

## The rules as coded

**Bulk** is 300 kWh or more, or a deal value over USD 20,000. Either is enough. kWh comes from "how many" (a total) or count times the pack size in "what". Value is price times quantity, in the price's own unit (per kWh, per unit, or for the lot); a price with no unit is no price. EUR is 1.16 and GBP 1.34 to USD (`USD_PER`, fixed 12 Nov 2026 from the CRM's standing EUR rates). Ranges count by their lowest reading for bulk and their highest for "under". Under the line only when both kWh and value are known and under; otherwise the size is **unknown: ask**.

**Route**, one per lead, Relay's suggestion with a one-line reason: recycling when their email says so (scrap, end of life, damaged, disposal; the quote must be in the email); else bulk deal for bulk or unknown size; marketplace for one pack under the line (`SMALL_MAX_UNITS`); Jules for more. Alex can change it on the card. Marketplace and Jules replies carry fixed pointer wording (`POINTERS`) and ask for nothing.

**Deal opens on send.** When a bulk or recycling lead's first reply has actually gone (its mail row is `accepted`), Relay opens the deal from the card's facts: no model, the same writes as Matcha's Create deal. Undo inside the 30-second hold leaves the card queued with no accepted email, so nothing is opened. A deal opens on what and how many alone; under the line (unless Alex picked the route) nothing opens.

**Qualified** (`bulk_listing_qualified`, same name and signature): every item on the route's checklist is answered or marked "they cannot provide it", a person checked each, and a person ticked Qualified. Items: supply resale what, how many, where, health; supply recycling what, how many, where, condition; demand what, how many, where. Price and when are asked in every ask but not needed for the tick: the checklist then shows "No price" / "No date". Test or QC documents over 12 months old are flagged. Two asks with what or how many still missing: the card proposes parking (never automatic). Listings the old rule qualified keep it, marked `qualified_by = 'before migration 117'`.

**Auto update.** A new reply on a thread linked to an open deal (newest message from them, last 3 days; handled once: one automatic job per message, ever, its id in the job's note, and none when a person ran a deal job after it arrived; a date in the future counts as now) queues "Update deal from this reply" by itself, through the same `startDealJob`: one job per email, same advisory lock, same 25-minute stale rule. Off with `RELAY_AUTO_DEAL_UPDATE=off`. A job whose result fails `dealResultFits` and that created its listing has that listing **closed** (reason `other`, with a Story note), not deleted, if nothing else uses it.

## New columns

| Where | Column | What it holds, and why |
|---|---|---|
| `crm_bulk_listings` | `route`, `route_reason` | bulk, marketplace, jules or recycling, and why. One route per lead, visible on the deal; picks the checklist. |
| `crm_bulk_listings` | `qualified_at`, `qualified_by` | the person's Qualified tick. Part three of the rule; the scorecard can tell a ticked deal from one kept by the old rule. |
| `crm_bulk_listing_fields` | `asked_at`, `asked_count` | when an item was last asked, and in how many emails. Drives first ask versus gaps-only, and the parking suggestion. |
| `crm_bulk_listing_fields` | `cannot_provide` | they told us they cannot give it. Counts as answered for Qualified. |
| `crm_bulk_listing_fields` | `checked_by`, `checked_at` | who checked the item. Part two of the rule. |
| `relay_card` | status `sent` | the reply went and the card was settled. One claim per card, so a deal opens once. |
| `relay_draft` | `ask_keys` | what a "Draft the ask" email asked for, counted as asked once it is sent. |
| `crm_bulk_offers` | index on `lower(contact)` where `role = 'contact'` | more than one contact per deal uses the existing contact offers; the scan and Relay now treat each as the deal's own party. |

Checklist state reuses `crm_bulk_listing_fields`, one row per item under the key `bulk_listing_check_field(kind, key)` names (model, quantity, location, soh, condition, seller_price, clear_by; demand product_family, max_price, needed_by). A row may hold only state until they answer. New SQL helpers: `bulk_listing_check_keys(id)`, `bulk_listing_check_answered(id, key)`, `bulk_listing_check_done(id, key)`. The listing stage trigger now also fires on `route`, `qualified_at`, `qualified_by`, `clear_by` and `email`.

## Not in the CRM

Matcha's `intake.md`, `creating-listings.md` and `RECIPE.md` still say EUR 20k: `patches/matcha-bulk-line-and-routes.patch`. Until it is applied, the Create deal prompt states the new rule. The Jules supply sync fix (one row per seller, product and quantity): `patches/jules-supply-one-row-per-lot.patch`.
