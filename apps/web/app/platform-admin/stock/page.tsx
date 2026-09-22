import { getStockPage } from "./actions";
import { StockClient } from "./stock-client";
import type { StockPageInput } from "./contract";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function StockPageRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const page = Number.parseInt(params.page ?? "1", 10);
  const data = await getStockPage({
    page: Number.isFinite(page) && page > 0 ? page : 1,
    search: params.search,
    supplier: params.supplier,
    status: params.status as StockPageInput["status"],
    chemistry: params.chemistry,
    scope: params.scope,
    commercialBucket: params.commercialBucket,
    sort: params.sort,
  });
  return <StockClient initialPage={data} />;
}
