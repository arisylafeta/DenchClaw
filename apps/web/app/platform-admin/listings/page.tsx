import { getListingPage } from "./actions";
import { ListingsClient } from "./listings-client";
import type { ListingPageInput } from "./contract";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function ListingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const page = Number.parseInt(params.page ?? "1", 10);
  const data = await getListingPage({
    page: Number.isFinite(page) && page > 0 ? page : 1,
    search: params.search,
    minKwh: params.minKwh,
    maxKwh: params.maxKwh,
    minWeightKg: params.minWeightKg,
    maxWeightKg: params.maxWeightKg,
    status: params.status as ListingPageInput["status"],
    channel: params.channel as ListingPageInput["channel"],
    sort: params.sort,
  });

  return <ListingsClient initialPage={data} />;
}
