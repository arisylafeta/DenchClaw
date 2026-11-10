import { guardRelay, readBody, relayError } from "@/lib/relay-route";
import { polishLeadAnswer } from "@/lib/relay-lead";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

/** "Add & polish" on a blue question: the gist Alex typed, worded as the answer for his reply. Nothing is saved or sent. */
export async function POST(req: Request, { params }: Context) {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  const body = await readBody(req);
  try {
    return Response.json({ text: await polishLeadAnswer(id, guard.user.id, { question: body?.question, text: body?.text }) });
  } catch (error) {
    return relayError(error);
  }
}
