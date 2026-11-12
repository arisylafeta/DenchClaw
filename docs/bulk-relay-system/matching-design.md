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

## Questions for Ari

1. One new table with an offer created only on Yes, or `candidate` offer rows? And may `bulk_listing_stage()` stop reading the frozen match tables?
2. Qualified is computed, not stored, and supply Qualified merged into Available on 28 Oct. What starts a match run: a person marking the deal ready, a job, or new supply for standing demand only?
3. On a supply deal the candidates are buyers. Who confirms first: the supplier of the lot or the buyer?
4. Does a reservation hold the whole candidate or a quantity of it, and for how long by default?
5. Should the model reorder the top five, or only write the reason over the scorer's order?
