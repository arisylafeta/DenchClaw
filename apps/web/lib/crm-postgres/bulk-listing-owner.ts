import { queryPg } from "../postgres";
import type { DealOwner } from "../bulk-owner";

/** Sets or clears (null) the deal owner of a demand or supply listing; kept in context.owner. */
export async function setListingOwner(id: string, owner: DealOwner | null): Promise<boolean> {
  const rows = await queryPg(
    `update crm_bulk_listings
        set context = case when $2::text is null then context - 'owner' else jsonb_set(context, '{owner}', to_jsonb($2::text)) end,
            updated_at = now()
      where id = $1 and kind in ('demand', 'supply') returning id`,
    [id, owner],
  );
  return rows.length > 0;
}
