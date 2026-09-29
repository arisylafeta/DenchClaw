---
name: rebattery-bulk-trades
description: Read or change ReBattery bulk trades (Bulk Trades v3 in DenchClaw) - next steps, buyers and their statuses, bids, per-field trade data with sources and buyer visibility, files, contacts, email tracking and the trade log. Use for "where are we on <trade>", preparing buyer outreach, or recording an approved update. For Postmark campaigns use rebattery-campaign-cli; for general CRM lookups use using-crm.
---

# ReBattery bulk trades (v3)

Bulk Trades is the DenchClaw screen at `https://crm.rebattery.io/?path=bulk_trade`: a List and Board
of live trades, and a page per trade with Overview (next step, buyers, missing data, shipping,
contacts) and Data and files. Data is in local Postgres `denchclaw`. Code:
`apps/web/lib/bulk-trades.ts`, `lib/bulk-trade-details.ts`, `lib/crm-postgres/bulk-trade*.ts`,
migrations `008` and `009`.

## Model

| Table | Holds |
| --- | --- |
| `crm_bulk_trade_lots` | One trade. v3 columns: `trade_stage` (Needs info, With buyers, Closing, Done, Lost), `trade_kind` (packs, cells, systems, recycling), `fact_line`, `next_step`, `next_step_due`, `waiting_on`, `value` (text), `clear_by`, `ship_by`, `transport_class`, `tfs_needed`, `listing_id`. Older Hermes columns (`stage`, `confidence`, `summary`, …) stay but are not shown. |
| `crm_bulk_trade_buyers` | Buyers for a trade: `status`, `wants`, `last_touch_on/via`, `chase_on`, optional `person_id` (CRM person, used for email tracking). |
| `crm_bulk_trade_bids` | Structured bids, never edited: amount, unit (kWh, pack, cell), currency, firm or indicative, terms, expiry. The latest per buyer is current. |
| `crm_bulk_trade_fields` | Per-field trade data keyed by `field_key` from the kind's template in `FIELD_TEMPLATES`: value, `status` (confirmed, unverified, conflict, missing), `visibility` ("buyers see at": teaser, after_nda, after_loi, never), source label, link and date, `alternatives` for conflicts. |
| `crm_bulk_trade_files` | Uploaded files (up to 25 MB): type, source, visibility (default never). Bytes are in the row, so the nightly database backup covers them; never public. |
| `crm_bulk_trade_contacts` | Supplier-side contacts. |
| `crm_bulk_trade_links` | Tracked links from Gmail drafts, with click counts. |
| `crm_bulk_trade_events` | Append-only log of every change (a trigger rejects update and delete). This is the history the matching learns from. |

## Read a trade

```sql
select id, title, trade_stage, trade_kind, next_step, next_step_due, waiting_on, value, listing_id
from crm_bulk_trade_lots where title ilike '%eBS37%';

select b.name, b.status, b.last_touch_on, b.chase_on, bid.amount, bid.unit, bid.currency, bid.firmness
from crm_bulk_trade_buyers b
left join lateral (select * from crm_bulk_trade_bids where buyer_id = b.id order by created_at desc limit 1) bid on true
where b.lot_id = $1 order by b.created_at;

select kind, changes, buyer_id, occurred_at from crm_bulk_trade_events where lot_id = $1 order by id desc limit 30;
```

The trade page's API returns the same in one call: `GET /api/bulk-trades/<id>` (signed-in session).
Missing data per step comes from `missingItems()`; do not recompute it differently in reports.

Email tracking on a buyer comes from two places. Campaign sends (`crm_campaign_sends`) to the
buyer's CRM person for the trade's `listing_id` give sent, delivered, opened, clicked, bounced.
Tracked links in Gmail drafts give clicks (`crm_bulk_trade_links`, `link_clicked` events). Report
clicks and replies as the real signal; opens are noisy (Apple Mail and Gmail image proxies).

## Inbox check (Phase 2)

`scripts/rebattery/bulk_trade_inbox_check.py` runs from Hermes cron ("Bulk Trades inbox check") at
08:00, 10:30, 13:00, 15:30 and 18:30 UK. It reads Alex's synced Gmail (`crm_email_messages`) and
Granola notes, matches them to trades by contacts, linked buyers and known threads, and stores
proposals in `crm_bulk_trade_proposals` (kinds: field, buyer_update, next_step, new_buyer, file,
link_contact, needs_triage, possible_trade). Each has a verbatim quote and its source. Runs are in
`crm_bulk_trade_check_runs`; the app header shows the latest. "Bulk Trades 08:05 summary for Alex"
sends him the overdue and due-today list on WhatsApp.

Never accept or ignore a proposal for Alex; that is his decision in the app. To debug a run, use
`--dry-run` (writes nothing). Adding a contact or linking a buyer to a CRM person is what makes
future mail match a trade.

## Rules

- **Buyer status changes only on Alex's confirm.** Never set a status from a campaign send, an
  email draft or an inferred reply. Propose it and let him confirm in the app.
- **Never send email.** Outreach from a trade is a Gmail draft in the signed-in user's account
  (`POST /api/bulk-trades/<id>/email-draft`, which runs `gog` limited to draft creation with
  sending blocked). Bulk teasers go through rebattery-campaign-cli with its own approvals.
- **Teasers and anything buyer-facing** use only fields with visibility `teaser` for the buyer's
  step, and never the seller price, location, local recycler or the seller's identity. Buyer
  subjects are neutral ("Battery batch available"); trade titles often name the seller. Use
  `teaserText()`, which enforces this.
- **Conflicts:** do not pick a side. Record the second claim in `alternatives` with its source and
  set status `conflict`; Alex settles it in Data and files.
- Seller price and supplier identity default to `never`; files default to `never`.

## Change a trade

Prefer the app or its API; they validate input and write the log. For an approved direct change
in Postgres (production data rules apply: explicit approval, a current backup for bulk changes),
write the row and its `crm_bulk_trade_events` entry in the same transaction, then read the trade
back:

```sql
begin;
update crm_bulk_trade_lots set next_step = $2, next_step_due = $3, updated_at = now() where id = $1;
insert into crm_bulk_trade_events (lot_id, kind, changes, actor_user_id)
values ($1, 'trade_updated', jsonb_build_object('next_step', jsonb_build_array($4::text, $2::text)), $5);
commit;
```

To load a whole trade from its sources (fields with sources, contacts, buyers and bids, files), write
a JSON pack outside git and run `scripts/rebattery/load_trade_pack.py pack.json` for a dry run; add
`--apply` once the dry run is approved. It only fills what is
empty, skips rows that exist, and logs every write.

Log `changes` as `{"field": [before, after]}`. Use `buyer_id` on buyer, bid and link events. Do not
create an active trade from an old email or cache without checking existing trades first.

## Test

`scripts/rebattery/crm-test-db.sh up` starts a throwaway Postgres with every migration and prints
the URL; run `BULK_TRADES_TEST_DATABASE_URL=<url> NODE_ENV=test npx vitest run lib/crm-postgres`
from `apps/web`, then `crm-test-db.sh down`. Preview screens with denchclaw-static-preview.
