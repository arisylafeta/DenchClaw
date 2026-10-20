import { currentUser } from "@/lib/auth";
import { canReadWhatsapp, whatsappInbox } from "@/lib/crm-postgres/whatsapp";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const user = await currentUser();
  if (!user) {return Response.json({ error: "Unauthorized" }, { status: 401 });}
  if (!canReadWhatsapp(user)) {return Response.json({ error: "Forbidden" }, { status: 403 });}
  const p = new URL(request.url).searchParams;
  try {
    return Response.json(await whatsappInbox(Number(p.get("limit") ?? 50), Number(p.get("offset") ?? 0)));
  } catch (error) {
    if (error instanceof Error && error.message === "invalid_pagination") {return Response.json({ error: error.message }, { status: 400 });}
    throw error;
  }
}
