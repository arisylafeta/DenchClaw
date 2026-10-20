import { currentUser } from "@/lib/auth";
import { canReadWhatsapp, whatsappConversation } from "@/lib/crm-postgres/whatsapp";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!canReadWhatsapp(user)) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id } = await context.params;
  const p = new URL(request.url).searchParams;
  try {
    const data = await whatsappConversation(
      id,
      Number(p.get("limit") ?? 50),
      Number(p.get("offset") ?? 0),
      ...(p.get("tail") === "1" ? [true] : []),
    );
    return data ? Response.json(data) : Response.json({ error: "Not found" }, { status: 404 });
  } catch (error) {
    if (error instanceof Error && error.message === "invalid_pagination") {
      return Response.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}
