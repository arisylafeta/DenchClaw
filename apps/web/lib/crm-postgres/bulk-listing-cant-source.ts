import { queryPg } from "../postgres";

/** Marks a demand listing as one we can't source, with the reason (context.cant_source); null clears it.
 * bulk_listing_stage() then shows the demand as Can't source until a deal is offered on it. */
export async function setListingCantSource(id: string, reason: string | null): Promise<boolean> {
  const rows = await queryPg(
    `update crm_bulk_listings
        set context = case when $2::text is null then context - 'cant_source' else jsonb_set(context, '{cant_source}', to_jsonb($2::text)) end,
            updated_at = now()
      where id = $1 and kind = 'demand' returning id`,
    [id, reason],
  );
  return rows.length > 0;
}
