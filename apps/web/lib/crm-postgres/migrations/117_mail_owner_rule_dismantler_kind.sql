-- Mail routing: a rule of kind 'dismantler' (value 'any') sends new mail from anyone at a company in crm_dismantlers
-- to one agent. Checked after sender, person and company rules, before domain and mailbox.
begin;
alter table mail_owner_rule drop constraint if exists mail_owner_rule_match_kind_check;
alter table mail_owner_rule add constraint mail_owner_rule_match_kind_check
  check (match_kind in ('tag', 'sender', 'person', 'company', 'dismantler', 'domain', 'mailbox'));
commit;
