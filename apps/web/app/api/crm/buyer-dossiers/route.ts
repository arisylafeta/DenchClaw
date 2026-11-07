import { currentUser } from "@/lib/auth";
import { listDossiersToReview } from "@/lib/crm-postgres/buyer-dossier";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Companies whose buyer dossier intake has flagged since it was last reviewed. */
export async function GET() {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const dossiers = await listDossiersToReview();
  return Response.json({ count: dossiers.length, dossiers });
}
