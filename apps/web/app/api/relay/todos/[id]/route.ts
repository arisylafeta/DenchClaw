import { guardRelay, readBody, relayError } from "@/lib/relay-route";
import { acceptTodo, setTodoState } from "@/lib/relay";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

/** accept → a Work Task in the Backlog; dismiss → hidden; done → the to-do and its Work Task are done. */
export async function POST(req: Request, { params }: Context) {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  const action = (await readBody(req))?.action;
  try {
    if (action === "accept") return Response.json(await acceptTodo(id, guard.user));
    if (action === "dismiss" || action === "done") { await setTodoState(id, guard.user.id, action === "dismiss" ? "dismissed" : "done"); return Response.json({ ok: true }); }
    return Response.json({ error: "action must be accept, dismiss or done" }, { status: 400 });
  } catch (error) {
    return relayError(error);
  }
}
