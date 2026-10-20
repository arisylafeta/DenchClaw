import { queryPg } from "../postgres";

/** Sets the one-line next action (and optional due date) of a demand or supply listing. Null clears it. */
export async function setListingNext(id: string, next: { next_action: string | null; next_due: string | null }): Promise<boolean> {
  const rows = await queryPg(
    `update crm_bulk_listings set next_action = $2, next_due = $3::date, updated_at = now()
     where id = $1 and kind in ('demand', 'supply') returning id`,
    [id, next.next_action, next.next_due],
  );
  return rows.length > 0;
}
