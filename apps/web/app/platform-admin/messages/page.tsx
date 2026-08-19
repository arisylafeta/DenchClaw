import { getMessagePage } from "./actions";
import type { MessagePageInput } from "./contract";
import { MessagesClient } from "./messages-client";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function MessagesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const page = Number.parseInt(params.page ?? "1", 10);
  const data = await getMessagePage({
    page: Number.isFinite(page) && page > 0 ? page : 1,
    search: params.search,
    from: params.from,
    to: params.to,
    status: params.status as MessagePageInput["status"],
  });

  return <MessagesClient initialPage={data} />;
}
