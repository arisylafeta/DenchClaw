import { guardRelay, readBody, relayError } from "@/lib/relay-route";
import { applySuggestion } from "@/lib/relay";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

/** "Use draft": Relay's own draft becomes the mail draft in Review, as long as it was written for the newest message shown. */
export async function POST(req: Request, { params }: Context) {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  const body = await readBody(req);
  try {
    const item = await applySuggestion(id, guard.user.id, typeof body?.for_message_id === "string" ? body.for_message_id : null);
    return Response.json({ item });
  } catch (error) {
    return relayError(error);
  }
}
