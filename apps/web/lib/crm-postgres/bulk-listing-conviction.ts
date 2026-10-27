import { queryPg } from "../postgres";
import type { Conviction } from "../bulk-conviction";

/** Sets the conviction of a demand or supply listing; medium is the default, so it clears the key. */
export async function setListingConviction(id: string, conviction: Conviction): Promise<boolean> {
  const rows = await queryPg(
    `update crm_bulk_listings
        set context = case when $2::text = 'medium' then context - 'conviction' else jsonb_set(context, '{conviction}', to_jsonb($2::text)) end,
            updated_at = now()
      where id = $1 and kind in ('demand', 'supply') returning id`,
    [id, conviction],
  );
  return rows.length > 0;
}
