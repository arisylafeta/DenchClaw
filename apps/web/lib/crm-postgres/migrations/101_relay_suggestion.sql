-- Relay drafts before Alex writes a note. Additive.
-- relay_item.suggestion: the reply Relay would send now, written for the newest message it saw:
--   {body, subject, needs_input: {question, options[]} | null, todos[], for_message_id, voice_version, at}
--   or, when drafting failed, {failed_for, error, at} so the same message is not retried every run.
begin;
alter table relay_item add column if not exists suggestion jsonb;
commit;
