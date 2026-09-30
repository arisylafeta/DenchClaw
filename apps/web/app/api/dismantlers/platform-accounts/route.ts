import { supplierAccounts } from "@/lib/dismantlers-platform";
import { guardDismantlers } from "@/lib/dismantlers-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET: ReBattery supplier accounts, names only, to link a dismantler by hand. */
export async function GET() {
  const guard = await guardDismantlers();
  if ("response" in guard) return guard.response;
  try {
    const accounts = await supplierAccounts();
    return Response.json({ accounts: accounts.map(({ id, name }) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)) });
  } catch {
    return Response.json({ error: "Could not read ReBattery just now." }, { status: 502 });
  }
}
