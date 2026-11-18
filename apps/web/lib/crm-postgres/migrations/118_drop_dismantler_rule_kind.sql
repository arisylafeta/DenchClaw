-- Undo 117: the 'dismantler' mail routing rule kind is dropped (Ari, 18 Nov 2026). Dismantler Campaigns owns only
-- threads its campaigns start; replies route by thread owner. No rule of this kind was ever added.
begin;
delete from mail_owner_rule where match_kind = 'dismantler';
alter table mail_owner_rule drop constraint if exists mail_owner_rule_match_kind_check;
alter table mail_owner_rule add constraint mail_owner_rule_match_kind_check
  check (match_kind in ('tag', 'sender', 'person', 'company', 'domain', 'mailbox'));
commit;
