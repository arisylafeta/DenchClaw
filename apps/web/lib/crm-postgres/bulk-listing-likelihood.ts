import { queryPg } from "../postgres";

/** Sets the completion likelihood (0-100 %) of a demand or supply listing; null clears it. */
export async function setListingLikelihood(id: string, likelihood: number | null): Promise<boolean> {
  const rows = await queryPg(
    `update crm_bulk_listings
        set context = case when $2::int is null then context - 'likelihood' else jsonb_set(context, '{likelihood}', to_jsonb($2::int)) end,
            updated_at = now()
      where id = $1 and kind in ('demand', 'supply') returning id`,
    [id, likelihood],
  );
  return rows.length > 0;
}
