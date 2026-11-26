import { guardRelay, readBody, relayError } from "@/lib/relay-route";
import { queryPg } from "@/lib/postgres";
import { RelayError } from "@/lib/relay";
import { decideSuggestion, openSuggestions, otherAddresses, unlinkAddress } from "@/lib/relay-people";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

async function addressOf(id: string, ownerId: string): Promise<string | null> {
  const [row] = await queryPg<{ email: string | null }>("select counterpart_email as email from relay_item where id = $1 and owner_id = $2::uuid", [id, ownerId]);
  if (!row) throw new RelayError(404, "Not found");
  return row.email?.trim().toLowerCase() || null;
}

/** The sender's other addresses (and why each is theirs), and the open "same person?" questions about them. */
export async function GET(_req: Request, { params }: Context) {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  try {
    const address = await addressOf(id, guard.user.id);
    const [also, questions] = await Promise.all([otherAddresses(guard.user.id, address), openSuggestions(guard.user.id, address)]);
    return Response.json({ address, also, questions });
  } catch (error) { return relayError(error); }
}

/** { unlink: address } stands one of their addresses alone again; { question, yes } answers a "same person?" question. Nothing is sent. */
export async function POST(req: Request, { params }: Context) {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  const body = await readBody(req);
  try {
    const address = await addressOf(id, guard.user.id);
    if (typeof body?.unlink === "string") {
      const also = await otherAddresses(guard.user.id, address);
      const target = body.unlink.trim().toLowerCase();
      if (!also.some((a) => a.address === target)) return Response.json({ error: "That address isn't linked to this person" }, { status: 400 });
      await unlinkAddress(guard.user.id, target, guard.user.email);
    } else if (typeof body?.question === "string" && typeof body?.yes === "boolean") {
      const open = await openSuggestions(guard.user.id, address);
      if (!open.some((q) => q.id === body.question)) return Response.json({ error: "That question is already answered" }, { status: 409 });
      await decideSuggestion(guard.user.id, body.question, body.yes, guard.user.email);
    } else {
      return Response.json({ error: "Send { unlink } or { question, yes }" }, { status: 400 });
    }
    const [also, questions] = await Promise.all([otherAddresses(guard.user.id, address), openSuggestions(guard.user.id, address)]);
    return Response.json({ address, also, questions });
  } catch (error) { return relayError(error); }
}
