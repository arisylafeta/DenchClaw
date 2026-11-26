-- Relay: nobody may sit on a person's email. When a person in an ongoing conversation has had no reply from anyone after
-- the hand-off window (24 h for an answer left to Jules, 48 h for anything else set aside), the scan brings the email back
-- to "Waiting on you" and records when the window ran out. Additive and idempotent.
begin;

alter table relay_item add column if not exists overdue_since timestamptz;

commit;
