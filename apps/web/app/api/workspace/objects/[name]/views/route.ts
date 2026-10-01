import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { getPostgresObjectViews, savePostgresObjectViews, updatePostgresObjectViewState } from "@/lib/crm-postgres/views";
import { getObjectViews, saveObjectViews } from "@/lib/workspace";
import type { SavedView, ViewTypeSettings } from "@/lib/object-filters";

type Params = { params: Promise<{ name: string }> };

/**
 * GET /api/workspace/objects/[name]/views
 *
 * Returns saved definitions and persisted selection/settings.
 */
export async function GET(_req: Request, ctx: Params) {
	const { name } = await ctx.params;
	const objectName = decodeURIComponent(name);

	try {
		if (process.env.CRM_DB_BACKEND === "postgres") {
			const user = await currentUser();
			if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
			const { views, activeView, viewSettings } = await getPostgresObjectViews(objectName, user.id);
			return NextResponse.json({ views, activeView, viewSettings });
		}

		const { views, activeView, viewSettings } = getObjectViews(objectName);
		return NextResponse.json({ views, activeView, viewSettings });
	} catch (err) {
		return NextResponse.json(
			{ error: `Failed to read views: ${err instanceof Error ? err.message : String(err)}` },
			{ status: 500 },
		);
	}
}

/**
 * PUT /api/workspace/objects/[name]/views
 *
 * Save definitions, or update selection/settings independently when views are omitted.
 * Body: { views?: SavedView[], activeView?: string | null, viewSettings?: ViewTypeSettings }
 */
export async function PUT(req: Request, ctx: Params) {
	const { name } = await ctx.params;
	const objectName = decodeURIComponent(name);

	try {
		const body = (await req.json()) as {
			views?: SavedView[];
			activeView?: string | null;
			viewSettings?: ViewTypeSettings;
		};

		let ok: boolean;
		if (process.env.CRM_DB_BACKEND === "postgres") {
			const user = await currentUser();
			if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
			ok = body.views === undefined
				? await updatePostgresObjectViewState(objectName, body, user.id)
				: await savePostgresObjectViews(objectName, body.views, body.activeView ?? undefined, body.viewSettings, user.id);
		} else {
			const previous = getObjectViews(objectName);
			ok = saveObjectViews(objectName, body.views ?? previous.views,
				Object.hasOwn(body, "activeView") ? body.activeView ?? undefined : previous.activeView,
				body.viewSettings ?? previous.viewSettings);
		}
		if (!ok) {
			return NextResponse.json(
				{ error: "Object directory not found" },
				{ status: 404 },
			);
		}

		return NextResponse.json({ ok: true });
	} catch (err) {
		return NextResponse.json(
			{ error: `Failed to save views: ${err instanceof Error ? err.message : String(err)}` },
			{ status: 500 },
		);
	}
}
