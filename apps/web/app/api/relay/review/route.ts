import { guardRelay, relayError } from "@/lib/relay-route";
import { listReview } from "@/lib/relay";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  try {
    return Response.json({ review: await listReview(guard.user.id) });
  } catch (error) {
    return relayError(error);
  }
}
