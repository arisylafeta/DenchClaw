/**
 * A draft from an earlier round: it went out before the email the item is open for now. Once they write again it is an
 * earlier email on the thread, not the reply in play, so the next reply starts fresh, and stays the one with Send once
 * it is drafted. A done item keeps showing what went out. `d` is the relay_draft row.
 */
export const EARLIER_ROUND_SQL = earlierRound("d.item_id");

function earlierRound(item: string): string {
  return `(d.state = 'sent' and exists (select 1 from relay_item ri where ri.id = ${item} and ri.status <> 'done'
  and ri.waiting_since is not null and coalesce(d.sent_at, d.updated_at) < ri.waiting_since))`;
}

/**
 * The drafts in play on an item ($n, its id): its own, and the replies on other people's threads that go with it
 * (linked_item_id). A linked reply is judged by this item's round, not its own thread's.
 */
export const inPlaySql = (n: string) => `d.state <> 'skipped' and ((d.item_id = ${n} and not ${EARLIER_ROUND_SQL}) or (d.linked_item_id = ${n} and not ${earlierRound(n)}))`;
/** On the page of an item it is only linked to, another thread's reply is one of the linked emails, not the reply. */
export const viewRoleSql = (n: string) => `case when d.item_id = ${n} then d.role else 'follow' end`;
