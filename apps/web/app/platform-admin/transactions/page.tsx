import { getTransactions } from "./actions";
import { TransactionsClient } from "./transactions-client";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function TransactionsPage() {
  const transactions = await getTransactions();
  return <TransactionsClient transactions={transactions} />;
}
