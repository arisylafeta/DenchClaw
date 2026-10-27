import { guardRelay, readBody, relayError } from "@/lib/relay-route";
import { addPromiseTodo } from "@/lib/relay";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

/** Accepts a promise found in the draft: a to-do plus a Work Task. */
export async function POST(req: Request, { params }: Context) {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  const title = (await readBody(req))?.title;
  if (typeof title !== "string" || !title.trim()) return Response.json({ error: "title required" }, { status: 400 });
  try {
    return Response.json(await addPromiseTodo(id, guard.user, title.trim()));
  } catch (error) {
    return relayError(error);
  }
}
