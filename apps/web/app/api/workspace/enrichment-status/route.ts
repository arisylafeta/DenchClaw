import { getIntegrationsState } from "@/lib/integrations";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/workspace/enrichment-status
 * Returns whether Apollo enrichment is available and, if not, why.
 */
export async function GET() {
	const state = getIntegrationsState();

	if (!state.denchCloud.isPrimaryProvider) {
		return Response.json({
			available: false,
			reason: "ReBattery Cloud is not the active provider.",
		});
	}

	if (!state.denchCloud.hasKey) {
		return Response.json({
			available: false,
			reason: "No ReBattery Cloud API key configured.",
		});
	}

	const apollo = state.integrations.find((i) => i.id === "apollo");
	if (!apollo || !apollo.enabled) {
		return Response.json({
			available: false,
			reason: "Apollo integration is not enabled.",
		});
	}

	return Response.json({ available: true });
}
