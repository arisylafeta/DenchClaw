import { currentUser } from "@/lib/auth";
import {
  getCompanyDossier,
  markDossierReviewed,
  saveDossier,
  type DossierSaveResult,
} from "@/lib/crm-postgres/buyer-dossier";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The company's buyer dossier. Same auth as every other company write.
 *
 *   GET   → the text, version, stale flag and saved searches
 *   PATCH { text, expected_version } → one guarded transaction; 409 when the editor is stale,
 *           400 with the validation errors when the dossier cannot be written
 *   POST  { action: "mark_reviewed" } → clears the stale flag without touching the text
 */

async function companyIdFrom(ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return id?.trim() ?? "";
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const companyId = await companyIdFrom(ctx);
  if (!companyId) return Response.json({ error: "Missing company id." }, { status: 400 });

  const dossier = await getCompanyDossier(companyId);
  if (!dossier) return Response.json({ error: "Company not found." }, { status: 404 });
  return Response.json(dossier);
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const companyId = await companyIdFrom(ctx);
  if (!companyId) return Response.json({ error: "Missing company id." }, { status: 400 });

  const body = (await req.json().catch(() => ({}))) as { text?: unknown; expected_version?: unknown };
  if (typeof body.text !== "string") {
    return Response.json({ error: "text is required." }, { status: 400 });
  }
  const expected = body.expected_version === null || body.expected_version === undefined
    ? null
    : Number(body.expected_version);
  if (expected !== null && !Number.isInteger(expected)) {
    return Response.json({ error: "expected_version must be a whole number." }, { status: 400 });
  }

  const result: DossierSaveResult = await saveDossier(companyId, body.text, expected);
  switch (result.kind) {
    case "missing":
      return Response.json({ error: "Company not found." }, { status: 404 });
    case "invalid":
      return Response.json({ error: "Dossier has errors.", errors: result.errors }, { status: 400 });
    case "conflict":
      return Response.json(
        {
          error: "The dossier changed while you were editing it. Reload to see the current version.",
          current_version: result.currentVersion,
          current_text: result.currentText,
        },
        { status: 409 },
      );
    case "saved":
      return Response.json({
        ok: true,
        version: result.version,
        updated_at: result.updated_at,
        profile: result.profile,
        derived: result.derived,
        passed_through: result.passedThrough,
        profile_changed: result.profileChanged,
      });
  }
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const companyId = await companyIdFrom(ctx);
  if (!companyId) return Response.json({ error: "Missing company id." }, { status: 400 });

  const body = (await req.json().catch(() => ({}))) as { action?: unknown };
  if (body.action !== "mark_reviewed") {
    return Response.json({ error: "Unsupported action." }, { status: 400 });
  }
  const dossier = await getCompanyDossier(companyId);
  if (!dossier) return Response.json({ error: "Company not found." }, { status: 404 });
  return Response.json(await markDossierReviewed(companyId));
}
