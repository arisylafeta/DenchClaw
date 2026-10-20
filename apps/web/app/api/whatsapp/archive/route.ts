import { currentUser } from "@/lib/auth";
import { canReadWhatsapp, whatsappArchiveChats, whatsappArchiveConversation } from "@/lib/crm-postgres/whatsapp";
export const dynamic = "force-dynamic";
/** Imported WhatsApp export chats: the list, or one chat's messages when ?chat= is given. */
export async function GET(request: Request) {
  const user = await currentUser();
  if (!user) {return Response.json({ error: "Unauthorized" }, { status: 401 });}
  if (!canReadWhatsapp(user)) {return Response.json({ error: "Forbidden" }, { status: 403 });}
  const p = new URL(request.url).searchParams;
  const chat = p.get("chat");
  try {
    if (!chat) {return Response.json(await whatsappArchiveChats());}
    const data = await whatsappArchiveConversation(chat, Number(p.get("limit") ?? 50), Number(p.get("offset") ?? 0), p.get("tail") === "1");
    return data ? Response.json(data) : Response.json({ error: "Not found" }, { status: 404 });
  } catch (error) {
    if (error instanceof Error && error.message === "invalid_pagination") {return Response.json({ error: error.message }, { status: 400 });}
    throw error;
  }
}
