import { currentUser } from "@/lib/auth";

type Guarded = { userId: string; email: string } | { response: Response };

/** Shared checks for Bulk Trades (and Dismantlers) routes: Postgres backend and a signed-in user. */
export async function guardBulkTrades(feature = "Bulk Trades"): Promise<Guarded> {
  if (process.env.CRM_DB_BACKEND !== "postgres") {
    return { response: Response.json({ error: `${feature} requires the Postgres backend` }, { status: 503 }) };
  }
  const user = await currentUser();
  if (!user) return { response: Response.json({ error: "Unauthorized" }, { status: 401 }) };
  return { userId: user.id, email: user.email };
}

export async function readJson(req: Request): Promise<unknown> {
  return req.json().catch(() => null);
}

export const badRequest = (error: string) => Response.json({ error }, { status: 400 });
export const notFound = (what: string) => Response.json({ error: `${what} not found` }, { status: 404 });

/** Runs a write and turns a missing linked record (Postgres foreign key error) into a 400. */
export async function linkedWrite(write: () => Promise<Response>): Promise<Response> {
  try {
    return await write();
  } catch (err) {
    if ((err as { code?: string }).code === "23503") return badRequest("A linked record no longer exists. Refresh and try again.");
    throw err;
  }
}
