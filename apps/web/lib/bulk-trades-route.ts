import { currentUser } from "@/lib/auth";

type Guarded = { userId: string } | { response: Response };

/** Shared checks for Bulk Trades routes: Postgres backend and a signed-in user. */
export async function guardBulkTrades(): Promise<Guarded> {
  if (process.env.CRM_DB_BACKEND !== "postgres") {
    return { response: Response.json({ error: "Bulk Trades requires the Postgres backend" }, { status: 503 }) };
  }
  const user = await currentUser();
  if (!user) return { response: Response.json({ error: "Unauthorized" }, { status: 401 }) };
  return { userId: user.id };
}

export async function readJson(req: Request): Promise<unknown> {
  return req.json().catch(() => null);
}

export const badRequest = (error: string) => Response.json({ error }, { status: 400 });
export const notFound = (what: string) => Response.json({ error: `${what} not found` }, { status: 404 });
