# Rolling back the bulk and Relay migrations

There are no down migrations. `rollback.sql` beside this note is the way back for the database. Nothing runs it by itself.

## When

Only together with a rollback of the web app to a build from before this branch. The old build reads `bulk_listing_stage()` and expects its old stage names (Offered, Negotiating, Agreed, Paid, Delivered, Available, Sourcing, Can't source). Against the new functions it puts listings in the wrong columns. If the new web build stays live, do not run it.

## What it does

- Drops every trigger migrations 116, 117, 118 and 119 added: stage events on offers, listings and listing fields, the paid-facts check, the match reservation check, match stage events, and the reservation made when a matched offer is offered.
- Puts back `bulk_listing_stage()` as in migration 096 and `bulk_listing_qualified()` as in migration 085, copied from `origin/main`.

It leaves the new tables (`crm_bulk_stage_events`, `crm_bulk_matches`), columns, constraints, helper functions and all their data in place. Nothing is deleted.

One data gap: migration 116 moved any `data.take_gbp` and numeric `terms.quantity` on offers into the new `take_gbp` and `quantity` columns. The old OKR page reads the old keys. To give it its take back, also run:

```sql
update crm_bulk_offers set data = data || jsonb_build_object('take_gbp', take_gbp) where take_gbp is not null and not data ? 'take_gbp';
```

## How

1. Take a backup of the CRM database first (`database-backups` skill).
2. Roll the web app back with `scripts/denchclaw-deploy.py rollback`.
3. Run `psql "$CRM_DATABASE_URL" -v ON_ERROR_STOP=1 -f docs/bulk-relay-system/rollback.sql`. It is safe to run twice.
4. Check: `select bulk_listing_stage(id) from crm_bulk_listings where status <> 'closed' limit 5;` returns old names, and an offer edit saves.

To go forward again, apply 116, 117, 118 and 119 in order. Each is safe to run twice, and 119 logs any stage that drifted meanwhile.

Walked on a throwaway database on 12 Nov 2026: migrations 001 to 119, then `rollback.sql` twice, then an offer update. Walked again after renumbering (12 Nov 2026): 001 to main's 111, then 116, 117, 118 and 119 twice each, then `rollback.sql`; it leaves main's `relay_draft.ways` alone.
