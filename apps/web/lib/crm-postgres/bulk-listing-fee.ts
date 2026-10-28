import { queryPg } from "../postgres";

/** Sets our fee (whole EUR) on a demand or supply listing, kept in context.fee_eur; null clears it, so the fee falls back to FEE_RATE of the value. */
export async function setListingFee(id: string, fee: number | null): Promise<boolean> {
  const rows = await queryPg(
    `update crm_bulk_listings
        set context = case when $2::numeric is null then context - 'fee_eur' else jsonb_set(context, '{fee_eur}', to_jsonb($2::numeric)) end,
            updated_at = now()
      where id = $1 and kind in ('demand', 'supply') returning id`,
    [id, fee],
  );
  return rows.length > 0;
}
