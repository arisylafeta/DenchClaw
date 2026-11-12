# Scorecard (slice 6)

For Alex and Ari, 12 Nov 2026. One place that says each Monday whether the bulk process is working. Code: `apps/web/lib/bulk-scorecard.ts` (the rules), `lib/crm-postgres/bulk-scorecard.ts` (the reads), `scripts/bulk-scorecard.ts` (the command), and the Scorecard block on Bulk Trades Today (`GET /api/bulk-scorecard`).

Every number is read with SELECTs only, in one transaction that is read only with `default_transaction_read_only` on, then rolled back. The script also opens its connections read-only. Nothing is sent.

## Periods

- **Week**: Monday 00:00 to Monday 00:00, London. By default the last full week before the run.
- **Week before**: the arrows (up, down, level) compare with it. No arrow when either week has no data.
- **Quarter to date**: 1 Dec 2026 to the run, ending 28 Feb 2027. Before 1 Dec it says "no data yet".
- **"No data yet"** means nothing could be counted, never zero. Items still inside their allowance are left out until they are on time or late: an enquiry under 2 working hours old, a lead under 2 working days, a match run under 3 working days.
- Working hours and days use the chase clock (`lib/chase-clock.ts`): Monday to Friday, 09:00 to 18:00 London, no bank holidays; the day something arrived is day 0.
- Rows with `source_kind = 'research'` are left out of every listing count. Rows with `source_kind = 'jules'` are counted on their own in the intake line.

## The eleven measures

| # | Measure | Baseline 12 Nov 2026 | Target |
|---|---|---|---|
| 1 | Enquiries answered within 2 working hours | under 11% | 80% |
| 2 | Bulk leads routed and decided within 2 working days | about 25% | 100% |
| 3 | Active deals, and how many are complete | 40 active | 20 or fewer, all complete |
| 4 | Deals in New for over 7 days | 11 | 0 |
| 5 | Match runs with 5 candidates judged within 3 working days | 0 | 90% |
| 6 | Offers quiet for 21+ days | 49 | 0 |
| 7 | Offers to buyers carrying a confirmed, in-date, priced quote | 9 of 76 | 80% |
| 8 | Match to agreed, median days | not recorded | 14 or fewer |
| 9 | Offered deals won | not recorded | 30% |
| 10 | Take recorded | not recorded | £15,000 Dec to Feb (week: a 13th of it) |
| 11 | Deals from first email to paid, every step prepared | none | 1 by end of February |

1. **Enquiries answered.** An enquiry is a Relay thread (`relay_item`) with a seller or buyer whose first message is theirs, from an address we had never sent to, arriving in the period; cards marked Not a lead (or that Relay read as not a lead) are left out. On time: our first sent, non-marketing email on that thread within 2 working hours.
2. **Bulk leads decided.** Enquiries whose lead card Relay routed to a bulk deal or recycling. Decided by working day 2: a deal opened for it (or the thread linked to an existing deal), the reply sent on another route Alex picked on the card, or the card dismissed as Not a lead. An enquiry with no card has no route and is not counted.
3. **Active deals.** As they stand now: open, past New, not Sold, Delivered or Lost (`isActive` in `lib/bulk-today.ts`). Complete: an owner, a ticket size, a chance and a next step with a due date. Not recorded for past weeks, so it has no arrow.
4. **Stuck in New.** Open deals in New for more than 7 days (`stuckInNew`, the Today tab's list) now. For the week before, the same rule over the stage history (`crm_bulk_stage_events`) as it stood at that week's end.
5. **Candidates judged.** Each deal's first match run that found candidates (the run's activity row) in the period. Judged: a yes or no recorded on 5 of its stored candidates, or all of them when the run found fewer, by working day 3 after the run.
6. **Quiet offers.** Counterparty offers in Offered or Negotiating whose last touch is 21 or more days old. A touch is a stage change, a message on the offer's linked email threads, its last touch date, or else when it was made. Now, and for the week before as it stood then (offers older than the stage history are not counted for a past week).
7. **Quoted offers.** Offers on supply listings (to buyers) first moved to Offered or further in the period. Counted: a buyer price, and the seller's quote passed the quote gate (`quoteGate`, offer-to-close.md) on the day it went out. The quote is read as stored now.
8. **Match to agreed.** Offers that came from a stored match (`crm_bulk_matches.offer_id`) and first reached Contract out or further in the period: calendar days from the match being stored to that change, the median.
9. **Won.** Offers that had been offered and first reached Paid, Complete, Declined or Lost in the period. Won is Paid or Complete, as a share of all of them. Starting rows from migration 111 are not changes.
10. **Take.** `take_gbp` summed over offers whose `paid_on` is in the period. A week is judged against £15,000 / 13 (about £1,154); the quarter against £15,000 (`TARGETS.bulk_take`). Comfortable is USD 10,000 a month. "No data yet" until a paid date exists.
11. **Fully prepared deal.** Offers paid in the period where every step is on record: the deal was opened by Relay from a sent lead card (`relay_card.data.sent.opened`); a stored match on the offer got a yes; the offer had a buyer price, passed the quote gate on the day it went out, and a price sheet (document type Quote) was sent with the email; and all five paid facts are recorded (quantity, paid on, amount, currency, take). The target is for the quarter, so only the quarter column is judged; a week without one is not marked as a miss.

The **three worst** in the Monday message are the three furthest from target in the week: a share's shortfall as a part of its target, a count that should be 0 as a part of its 12 Nov baseline, and active deals by the larger of the excess over 20 and the share incomplete. Measures with no data or on target are not ranked.

## The command

From `apps/web`, with the same `DATABASE_URL` as the web app:

```bash
node --conditions=react-server --import tsx scripts/bulk-scorecard.ts                     # print it
node --conditions=react-server --import tsx scripts/bulk-scorecard.ts --message <file>    # also write the Monday message
node --conditions=react-server --import tsx scripts/bulk-scorecard.ts --week 2026-12-07   # another week
```

It ends with the daily housekeeping the database is missing: reservations past their last day still marked offered (`bulk_matches_expire()` has not run), and open listings whose stage differs from the last one logged, including holds that ended with no event (`bulk_stage_check_all()` has not run).

## Proposed schedule, for Alex to approve

Nothing below is scheduled. Each line is a proposal.

1. **Daily, 06:17 London**: tidy reservations and catch stage changes that happen without a write (a hold or a reservation running out). These two are the only writes in this note, and both only make the record match what the stage functions already say.

   ```bash
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "select bulk_matches_expire() as reservations_expired, bulk_stage_check_all() as stage_events_logged"
   ```

2. **Monday, 07:43 London**: write the Monday message and show it to Alex. The script writes a file only; who sends it, and where (WhatsApp or Discord), is Alex's call, and a person sends it until he says otherwise.

   ```bash
   cd /root/.hermes/projects/denchclaw/apps/web && \
     node --conditions=react-server --import tsx scripts/bulk-scorecard.ts --message /root/.hermes/workspace/bulk-scorecard/monday-$(date +%F).txt
   ```

If approved, both go in `/root/.hermes/cron/jobs.json` as Hermes jobs. Run the daily one before the Monday one, so the Monday numbers read a tidy database.
