import { currentUser } from "@/lib/auth";
import { canReadWhatsapp, whatsappThreads } from "@/lib/crm-postgres/whatsapp";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const user = await currentUser();
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!canReadWhatsapp(user)) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  const p = new URL(request.url).searchParams;
  try {
    return Response.json(
      await whatsappThreads(
        {
          personId: p.get("personId") ?? undefined,
          companyId: p.get("companyId") ?? undefined,
          tradeId: p.get("tradeId") ?? undefined,
        },
        Number(p.get("limit") ?? 50),
        Number(p.get("offset") ?? 0),
      ),
    );
  } catch (error) {
    if (error instanceof Error && error.message === "invalid_pagination") {
      return Response.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}
