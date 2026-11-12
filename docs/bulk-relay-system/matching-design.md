# Stored matching for bulk deals: data structure

Pre-read for Ari, 12 Nov 2026. Proposal from Sean and Alex (4 Nov). Code read on this worktree; no database queried.

## The problem

1. Matches are worked out on every page load and thrown away. Shortlist and Not a fit survive only as activity rows (`crm_bulk_listing_activity.data.match`), and no supplier or buyer answer to a match is recorded anywhere, so there is nothing to learn from.
2. The last stored matches (`crm_bulk_trade_demand_matches` / `_supply_matches`, now frozen) included already-contracted stock, yet `bulk_listing_stage()` still reads them to show Found and Available.
3. Nothing reserves stock. `counterpart_id` only dedupes listing-to-listing pairs, so one stock line or lot can be quoted to two buyers.

## Proposed structure: one new table, `crm_bulk_matches`

One row per deal and candidate. Unique on (`deal_id`, `candidate_kind`, `candidate_id`).

| Column | Holds | Why |
|---|---|---|
| `deal_id` | the qualified `crm_bulk_listings` row | anchor |
| `candidate_kind`, `candidate_id` | `listing`, `marketplace` or `stock` plus its id | the three sources in one shape |
| `rank` | 1 to 5 while live, null once out | the top five |
| `checks` | scorer output: exact or check, each requirement pass / partial / unknown / fail, margin, EUR per kWh | explains the ranking later |
| `reason` | one or two sentences citing the facts | what the draft and the reviewer read |
| `scored_by` | scorer commit, model and prompt version | reproduce any result |
| `state` | proposed, asked, confirmed, declined, replaced, offered, expired | the lifecycle |
| `asked_at`, `chases` | when the supplier was asked, chases sent (max 3) | day 1, 3, 5 chasing |
| `verdict`, `verdict_reason`, `verdict_at`, `verdict_by` | yes or no, why, when, user or CRM person | the outcome record |
| `reserved_until` | set when the offer goes out | Reserved, never offered twice |
| `offer_id` | the `crm_bulk_offers` row drafted on Yes | hands over to the deal stages |

A partial unique index allows one live reservation per candidate across all deals. Verdicts still write an activity row so History keeps working.

**Reused, not added:** the scorer (`scoreCandidate`, `matchDemand`, `match/rules.ts`, the product key); standing versus one-off demand, already `spec.intent` on demand listings; offers from Yes onwards. **Not reused:** the `hold_*` columns from 071. They pause a whole listing and cannot hold a stock line or marketplace item.

**Option weighed: a `candidate` offer row as the stored match.** No new table, and the stage already drives Found and Available. But offers have no rank, reason or checks columns, `declined` already means a buyer said no, and five candidate rows would mark every qualified deal Found at once. Recommendation: the new table, and an offer row only on Yes.

## How a match is scored

The deterministic scorer narrows: it rules out only on a conflict both sides state, then orders by fixed keys. There is no single score number, by design, so `checks` stores the full result. Optionally, as the 4 Nov call preferred, a model reads the top candidates with buy-box text and history, writes `reason` and orders the five. `scored_by` records which.

## Left out for now

Buyer deep-research profiles, speed of reply as a ranking input, and any automatic sending. A person sends every draft and offer.

## Risks

- **Duplicate offers:** two deals reach the same stock line. The reservation index blocks the second offer; the second deal moves to its next candidate.
- **Stale candidates:** stock sells or goes stale after scoring. Re-check a candidate's live status before asking and before offering; mark it `expired`, not deleted.
- **Privacy:** neither side is named to the other. `reason` and drafts use teaser-visible fields only, and drafts name no counterparty.

## Decisions (Alex, 12 Nov 2026)

1. One new table, `crm_bulk_matches`; an offer row is created only on Yes. `bulk_listing_stage()` stops reading the frozen match tables.
2. A match run starts when a person marks the deal ready.
3. The seller's price is always locked first. On a supply deal: if the seller's quote is in date, go straight to the buyers; if it is expired or missing, draft a re-confirm to the seller and offer buyers only once it is back.
4. A reservation holds a quantity, not the whole lot. Default 5 working days, or the seller's quote expiry if sooner. Shown on the card, lapses by itself, one click to extend. Internal only: it removes nothing from the marketplace.
5. The model may reorder the top five. Both the scorer's order and the model's order are stored.

## Questions as first asked

1. One new table with an offer created only on Yes, or `candidate` offer rows? And may `bulk_listing_stage()` stop reading the frozen match tables?
2. Qualified is computed, not stored, and supply Qualified merged into Available on 28 Oct. What starts a match run: a person marking the deal ready, a job, or new supply for standing demand only?
3. On a supply deal the candidates are buyers. Who confirms first: the supplier of the lot or the buyer?
4. Does a reservation hold the whole candidate or a quantity of it, and for how long by default?
5. Should the model reorder the top five, or only write the reason over the scorer's order?

## As built (slice 4, 12 Nov 2026)

Migration `113_bulk_matches.sql`; code in `lib/crm-postgres/bulk-matches.ts`, `lib/match/stored-match.ts`, `lib/match/match-ranker.ts`; the Matches tab in `app/components/bulk-trades/stored-matches.tsx`; routes under `/api/bulk-listings/[id]/stored-matches`.

**Columns of `crm_bulk_matches`.** `id` (`bmt_…`), `deal_id`, `candidate_kind` (`listing`, `marketplace`, `stock`, `company`), `candidate_id`, `candidate_key` (the Matches row key), `name`, `company_id`, `person_id`, `contact`, `stock_kind` and `stock_id` (what a reservation holds: the candidate on a request, the deal itself on a supply deal), `candidate_qty` (the candidate's units at the run, null when not stated), `rank` (1 to 5 while in the five; the model's order), `scorer_rank`, `checks`, `reason`, `scored_by` (`scorer`, `model`, `prompt`, `fallback` when the model step was not used), `state`, `note`, `asked_at`, `chases` (0 to 3), `verdict`, `verdict_reason`, `verdict_at`, `verdict_by`, `confirmed_qty`, `quote` (`amount`, `currency`, `unit`), `quote_valid_until`, `reserved_qty`, `reserved_until`, `offer_id`, `data` (the open ask draft), `created_at`, `updated_at`. Unique on (`deal_id`, `candidate_kind`, `candidate_id`) and on `offer_id`. A no needs a reason (check constraint).

**The reservation rule.** A reservation is live while the match is `offered` and `reserved_until` is today or later; anything older reads as free everywhere, with no write. A trigger (`bulk_match_check_reservation`) runs before any write that makes or changes a live reservation: it takes an advisory lock on the stock, sums the other live reservations on it, and refuses (SQLSTATE 23P01) when the total would pass `candidate_qty`, or when the quantity is unknown and another live reservation exists. A trigger was chosen over an index because a sum cannot be indexed. Reservations are made by the database when a matched offer moves to `offered` (`bulk_match_offered`): the yes's quantity, for 5 working days or to the quote's last day if sooner. If the rule refuses, the offer still moves and the match's note says "Not reserved: …". Runs and Yes leave out a candidate fully reserved by other deals. A declined or lost offer turns its match into a no and ends its reservation. `bulk_matches_expire()` marks lapsed rows `expired`, for the daily job beside `bulk_stage_check_all()` (not scheduled).

**What counts for the stage.** `bulk_listing_has_match()` counts a match that is `asked`, `confirmed` or `offered`, on the deal or naming the listing as its candidate. `proposed` does not count: a run proposes five on every deal, and counting them would make every qualified request Sourcing and every supply Available at once. Supply **Reserved** is now `hold_until` today or later, or a live reservation against the listing (`bulk_listing_reserved()`). Match writes re-check the listings they touch, so stage events fire as with offers.

**Differs from the note.**
- `crm_bulk_listings.context.match_run` records the last run (`at`, `by`, `count`, `checked_at`); `context.match_reconfirm` the open seller re-confirm. No run table.
- The seller's quote on a supply deal is in date when the `seller_price` field is `confirmed` and `spec.seller_quote_valid_until` is today or later. "Seller confirmed" in the tab sets both. Until then a buyer cannot be asked or confirmed.
- Ask marks the match `asked` when the draft is made (by the existing offer draft path), not when it is sent; a person sends it from the draft panel.
- New supply for standing requests is checked when the request's Matches tab is opened (`markNewSupply`), so supply added by any path is caught; it marks, nothing more.
- The model sees no names or contacts; its reasons are refused if they name any party or cite a figure not in that candidate's facts, and then the scorer's order and plain reasons are kept.
