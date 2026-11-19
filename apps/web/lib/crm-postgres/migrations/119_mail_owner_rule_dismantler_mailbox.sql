-- Mail routing: a rule of kind 'dismantler' sends new mail from anyone at a crm_dismantlers company to one agent.
-- Value is the mailbox key it reached ('ari') or 'any'. Checked after sender, person and company rules, before domain
-- and mailbox. The sender's company is resolved by CRM person, exact email, or a unique non-free-mail domain.
-- (Ari, 19 Nov 2026: dismantler mail to ari@ goes to Dismantler Campaigns.)
begin;
alter table mail_owner_rule drop constraint if exists mail_owner_rule_match_kind_check;
alter table mail_owner_rule add constraint mail_owner_rule_match_kind_check
  check (match_kind in ('tag', 'sender', 'person', 'company', 'dismantler', 'domain', 'mailbox'));
commit;
