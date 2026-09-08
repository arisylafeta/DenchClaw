import { getBatteryRequests } from "./reads";
import { BatteryRequestsView } from "./requests-view";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function BatteryRequestsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const data = await getBatteryRequests({
    page: typeof params.page === "string" ? params.page : undefined,
    email: typeof params.email === "string" ? params.email : undefined,
  });
  return <BatteryRequestsView data={data} />;
}
