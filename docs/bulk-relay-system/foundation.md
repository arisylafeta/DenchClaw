# Bulk foundation: stage history, paid facts and stages

For Ari, 12 Nov 2026. What migration 111 (`apps/web/lib/crm-postgres/migrations/111_bulk_stage_events.sql`) adds, and how a stage is worked out. Nothing else in the bulk schema changed.

## New table: `crm_bulk_stage_events`

One row each time an offer's stage or a listing's stage changes. It is the only stage history; nothing else stores a stage.

| Column | Holds | Why |
|---|---|---|
| `id` | running number | orders events written in the same instant |
| `subject_kind`, `subject_id` | `listing` or `offer`, and its id | one table covers both, so one query gives a deal's whole story |
| `from_stage`, `to_stage` | the stage before and after (`from_stage` is empty on the first event) | time in each stage, and how often deals go backwards |
| `occurred_at` | when it changed | stage timing for chases and the scorecard |
| `actor` | the user's email, an agent name, or `system` | who moved it; writers set `bulk.actor` for their transaction, else `system` |
| `note` | free text; `As of migration 111` on the starting rows | marks the one starting event per open listing and offer, so no history is invented |

## New columns on `crm_bulk_offers`

| Column | Holds | Why |
|---|---|---|
| `quantity` | how much was sold, in the offer's price unit (`terms.unit`) | volume per deal; the OKR page read `terms.quantity`, which nothing wrote |
| `paid_on` | the date the money came in | take counts in the week and period it was paid, not when the row was last edited |
| `paid_amount`, `paid_currency` | what the counterparty paid, and in GBP, EUR or USD | closed value from real money; the two are set together or not at all |
| `take_gbp` | our take on the deal in pounds | the one number the £15,000 target (Dec 2026 to Feb 2027) is measured on |

Moving an offer to Paid or Complete through the app asks for all five; the API answers 400 naming what is missing. Any `terms.quantity` or `data.take_gbp` values were moved into these columns, so each fact lives in one place.

## How a stage is worked out

Stages are never stored. SQL functions compute them from the listing and its counterparty offers:

- `bulk_listing_has_match(id)`: a live counterparty offer (not declined or lost) on or pointing at the listing. This is the one seam for stored matching: when `crm_bulk_matches` arrives, only this function changes.
- `bulk_listing_stage(id)`, the list stage:
  - Requests: **Closed** when closed; **Found** once a supplier has been offered; **Sourcing** with a match, or qualified and a match run started; **Qualified**; **New**.
  - Supply: **Sold** when an offer is paid or complete, or it closed as sold; **Closed** when it closed otherwise; **Reserved** while on hold (`hold_until` today or later) or a live reservation holds some of it; **Available** with a match, or qualified and a match run started; **Qualified**; **New**.
  - "A match run started" (migration 115, `bulk_listing_match_started`): a person ran matching on the deal, which Alex set as marking it ready (12 Nov 2026); `runMatches` keeps the last run in `context.match_run`. Until 115 an owner (`context.owner`) moved a qualified deal on, but every new deal is now owned by Alex when it opens, so Qualified was skipped. The owner no longer moves a stage. Migration 115 re-checks every open listing once, so deals the old rule had moved on get a "back to Qualified" event from `system`.
- `bulk_listing_deal_stage(id)`, the Deals board: the furthest live offer, as **Offered**, **Negotiating**, **Agreed** (contract out, signed or invoiced), **Paid** or **Delivered** (complete); **Lost** when every counterparty offer is declined or lost; empty until something is offered.

"Qualified" is `bulk_listing_qualified` (migration 085, the checklist rule since 112; see front-door.md). Neither function reads the retired `crm_bulk_trade_*` tables. A Can't source reason is a tag on the card, not a stage.

## How events get written

Database triggers, not app code, so a change from the app, an agent or plain SQL is caught the same way:

- an offer insert, stage change or move between listings logs the offer event, then re-checks both listings it touches;
- a listing change (status, hold, owner, the facts that qualify it) and a change to its qualifying fields re-check that listing;
- a listing event is written only when the computed stage differs from the last one logged.

An offer reaching **complete** closes both listings: the request as `bought_from_us`, the supply as `sold`.

One gap: a hold that runs out changes the stage without any write. `bulk_stage_check_all()` re-checks every open listing and should run once a day; it is not scheduled yet.
