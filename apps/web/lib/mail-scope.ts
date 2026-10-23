/** Mail identity defines sharing; the Gmail capture owner is provenance, not an ACL. */
export function mailboxScopeSql(alias: string, owner: string) {
  const parties = `array[${alias}.from_email,${alias}.recipient_email] || coalesce(${alias}.to_emails,'{}') || coalesce(${alias}.cc_emails,'{}') || coalesce(${alias}.bcc_emails,'{}')`;
  const personalParties = `select 1 from unnest(${parties}) address where lower(address) in ('alex@rebattery.io','ari@rebattery.io')`;
  return `(case
    when ${alias}.identity_key in ('alex','ari') then exists (
      select 1 from crm_users mailbox_user where mailbox_user.id = ${owner}::uuid
      and lower(mailbox_user.email) = ${alias}.identity_key || '@rebattery.io')
    when ${alias}.identity_key is not null then exists (
      select 1 from mail_identity shared_identity where shared_identity.key = ${alias}.identity_key
      and shared_identity.key not in ('alex','ari'))
    when ${alias}.mailbox_owner_id is not null then ${alias}.mailbox_owner_id = ${owner}::uuid
    when exists (${personalParties}) then exists (
      select 1 from crm_users mailbox_user where mailbox_user.id = ${owner}::uuid
      and lower(mailbox_user.email) in (select lower(address) from unnest(${parties}) address))
    else coalesce('shared' = any(${alias}.labels),false)
  end)`;
}
