import { guardRelay, readBody, relayError } from "@/lib/relay-route";
import { addTask } from "@/lib/relay";

export const dynamic = "force-dynamic";

/** A to-do added on the To-dos tab: saved and created as a Work Task in the Backlog. */
export async function POST(req: Request) {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  const body = await readBody(req);
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  if (!title) return Response.json({ error: "Add what needs doing." }, { status: 400 });
  try {
    return Response.json(await addTask(guard.user, title, typeof body?.due === "string" && body.due.trim() ? body.due.trim().slice(0, 40) : null));
  } catch (error) {
    return relayError(error);
  }
}
