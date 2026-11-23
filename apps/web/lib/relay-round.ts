/**
 * A draft from an earlier round: it went out before the email the item is open for now. Once they write again it is an
 * earlier email on the thread, not the reply in play, so the next reply starts fresh, and stays the one with Send once
 * it is drafted. A done item keeps showing what went out. `d` is the relay_draft row.
 */
export const EARLIER_ROUND_SQL = `(d.state = 'sent' and exists (select 1 from relay_item ri where ri.id = d.item_id and ri.status <> 'done'
  and ri.waiting_since is not null and coalesce(d.sent_at, d.updated_at) < ri.waiting_since))`;
