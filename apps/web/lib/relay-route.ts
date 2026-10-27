import { currentUser, type AuthenticatedUser } from "./auth";
import { canUseRelay, RelayError } from "./relay";
import { DraftActionError } from "./mail-draft-actions";

/** Every Relay route: signed in, Postgres backend, and Alex only. Anyone else gets a plain 404. */
export async function guardRelay(): Promise<{ user: AuthenticatedUser } | { response: Response }> {
  if (process.env.CRM_DB_BACKEND !== "postgres") return { response: Response.json({ error: "Relay requires the Postgres backend" }, { status: 503 }) };
  const user = await currentUser();
  if (!user) return { response: Response.json({ error: "Unauthorized" }, { status: 401 }) };
  if (!canUseRelay(user.email)) return { response: Response.json({ error: "Not found" }, { status: 404 }) };
  return { user };
}

export function relayError(error: unknown): Response {
  if (error instanceof RelayError || error instanceof DraftActionError) return Response.json({ error: error.message }, { status: error.status });
  console.error("relay", error);
  return Response.json({ error: "Something went wrong. Try again." }, { status: 500 });
}

export const readBody = async (req: Request) => (await req.json().catch(() => null)) as Record<string, unknown> | null;
