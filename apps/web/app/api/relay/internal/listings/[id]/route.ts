import { internalAuthorised } from "@/lib/relay-learn";
import { RelayError } from "@/lib/relay";
import { DraftActionError } from "@/lib/mail-draft-actions";
import { finishListings } from "@/lib/relay-listings";
import { readBody } from "@/lib/relay-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

const strings = (v: unknown, max: number): string[] | null =>
  Array.isArray(v) && v.length <= max && v.every((x) => typeof x === "string" && x.length > 0 && x.length < 200) ? (v as string[]) : null;

/** relay_listings.py's result for one proposal (internal secret only): the links go into the reply, never into storage. */
export async function POST(req: Request, { params }: Context) {
  if (!internalAuthorised(req)) return Response.json({ error: "Not found" }, { status: 404 });
  const { id } = await params;
  const body = await readBody(req);
  try {
    if (body?.ok === false) {
      await finishListings(id, { ok: false, error: typeof body.error === "string" ? body.error.slice(0, 300) : "The listing job failed." });
      return Response.json({ ok: true });
    }
    const links = Array.isArray(body?.links) && body.links.length >= 1 && body.links.length <= 6
      && body.links.every((l: unknown) => !!l && typeof (l as { label?: unknown }).label === "string" && typeof (l as { url?: unknown }).url === "string"
        && /^https:\/\/(www\.|staging\.)?rebattery\.io\//.test((l as { url: string }).url))
      ? (body.links as { label: string; url: string }[]).map((l) => ({ label: l.label.slice(0, 80), url: l.url })) : null;
    const listingIds = strings(body?.listingIds, 6);
    const invitationIds = strings(body?.invitationIds, 6);
    const expiresAt = typeof body?.expiresAt === "string" && !Number.isNaN(Date.parse(body.expiresAt)) ? body.expiresAt : null;
    if (!links || !listingIds || !invitationIds || !expiresAt) return Response.json({ error: "links, listingIds, invitationIds and expiresAt required" }, { status: 400 });
    await finishListings(id, { ok: true, links, listingIds, invitationIds, expiresAt });
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof RelayError || error instanceof DraftActionError) return Response.json({ error: error.message }, { status: error.status });
    console.error("relay listings finish", error);
    return Response.json({ error: "Couldn't record the result." }, { status: 500 });
  }
}
