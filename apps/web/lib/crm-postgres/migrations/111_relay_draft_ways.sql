-- Relay review: the other ways to answer an email. Next to the draft Alex already has, Relay writes up to two whole
-- replies that handle the email differently (answer now, ask first, hold). He reads them as tabs and picks one; the
-- picked one becomes the draft. Nothing here is ever sent on its own.
begin;

-- ways: {status: preparing | ready | failed, picked, ways: [{title, body, original}], at}. ways[picked] is the draft
-- itself (its body is refreshed from the mail when he picks another). original: the way as Relay wrote it, copied to
-- original_body on a pick so his edits are learned against the right text. Null: not written yet, or a follow-on.
alter table relay_draft add column if not exists ways jsonb;
commit;
