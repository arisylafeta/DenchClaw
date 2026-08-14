import { getAccounts } from "./actions";
import { AccountsClient } from "./accounts-client";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function AccountsPage() {
  const accounts = await getAccounts();

  return <AccountsClient accounts={accounts} />;
}
