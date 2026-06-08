import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  advanceOnboardingStep,
  readOnboardingState,
} from "@/lib/denchclaw-state";
import { resolveOpenClawStateDir } from "@/lib/workspace";
import { writeDenchAuthProfileKey } from "@/lib/dench-auth";
import {
  resolveComposioApiKey,
} from "@/lib/composio";
import {
  saveApiKey,
  selectModel,
} from "@/lib/dench-cloud-settings";
import {
  RECOMMENDED_DENCH_CLOUD_MODEL_ID,
  readConfiguredDenchCloudSettings,
} from "../../../../../../src/cli/dench-cloud";
import { trackServer } from "@/lib/telemetry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type UnknownRecord = Record<string, unknown>;

function readOpenClawConfig(): UnknownRecord {
  const path = join(resolveOpenClawStateDir(), "openclaw.json");
  if (!existsSync(path)) {return {};}
  try {
    return (JSON.parse(readFileSync(path, "utf-8")) as UnknownRecord) ?? {};
  } catch {
    return {};
  }
}

function isDenchCloudPrimary(config: UnknownRecord): { ok: boolean; primary: string | null } {
  const settings = readConfiguredDenchCloudSettings(config);
  if (settings.selectedModel) {
    return { ok: true, primary: `dench-cloud/${settings.selectedModel}` };
  }
  const agents = config.agents as UnknownRecord | undefined;
  const defaults = agents?.defaults as UnknownRecord | undefined;
  const model = defaults?.model;
  const primary = typeof model === "string" ? model : (model as UnknownRecord | undefined)?.primary;
  if (typeof primary === "string" && primary.startsWith("dench-cloud/")) {
    return { ok: true, primary };
  }
  return { ok: false, primary: typeof primary === "string" ? primary : null };
}

export async function GET() {
  const config = readOpenClawConfig();
  const apiKey = resolveComposioApiKey();
  const primary = isDenchCloudPrimary(config);

  return Response.json({
    configured: Boolean(apiKey) && primary.ok,
    source: Boolean(apiKey) && primary.ok ? "cli" : null,
    primaryModel: primary.primary,
  });
}

type PostBody = { apiKey?: unknown; acceptCli?: unknown; model?: unknown };

export async function POST(req: Request) {
  let body: PostBody = {};
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const acceptCli = body.acceptCli === true;

  if (acceptCli) {
    // Confirm Dench Cloud really *is* set up (defends against a stale
    // detection from before the user ran the CLI bootstrap).
    const config = readOpenClawConfig();
    const apiKey = resolveComposioApiKey();
    if (!apiKey || !isDenchCloudPrimary(config).ok) {
      return Response.json(
        { error: "Dench Cloud is not configured yet. Paste your API key to continue." },
        { status: 400 },
      );
    }
    const next = advanceOnboardingStep("dench-cloud", "connect-gmail", {
      denchCloud: {
        source: "cli",
        skipped: false,
        configuredAt: new Date().toISOString(),
      },
    });
    trackServer("onboarding_dench_cloud_accepted", { source: "cli" });
    return Response.json(next);
  }

  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (!apiKey) {
    return Response.json({ error: "`apiKey` is required." }, { status: 400 });
  }
  if (!apiKey.startsWith("dench_")) {
    return Response.json(
      { error: "Dench Cloud API keys start with `dench_`. Double-check the value you pasted." },
      { status: 400 },
    );
  }

  // Validate + persist into openclaw.json (provider config, models entries, MCP).
  const saveResult = await saveApiKey(apiKey, { syncAuthProfile: false });
  if (saveResult.error) {
    return Response.json({ error: saveResult.error }, { status: 400 });
  }

  // Pick the recommended model as primary so chat works out of the box.
  const requestedModelId =
    typeof body.model === "string" && body.model.trim()
      ? body.model.trim()
      : RECOMMENDED_DENCH_CLOUD_MODEL_ID;
  const recommended =
    saveResult.state.models.find((model) => model.id === requestedModelId) ??
    saveResult.state.models.find((model) => model.id === RECOMMENDED_DENCH_CLOUD_MODEL_ID) ??
    saveResult.state.models[0];
  if (recommended) {
    const modelResult = await selectModel(recommended.stableId);
    if (modelResult.error) {
      return Response.json({ error: modelResult.error }, { status: 400 });
    }
  }

  // Mirror into auth-profiles.json so the agent runtime sees the same key.
  writeDenchAuthProfileKey(apiKey);

  const next = advanceOnboardingStep("dench-cloud", "connect-gmail", {
    denchCloud: {
      source: "web",
      skipped: false,
      configuredAt: new Date().toISOString(),
    },
  });
  trackServer("onboarding_dench_cloud_accepted", { source: "web" });
  return Response.json(next);
}

export async function DELETE() {
  const current = readOnboardingState();
  if (current.currentStep !== "dench-cloud") {
    return Response.json(
      { error: "Skip is only available from the Dench Cloud step." },
      { status: 400 },
    );
  }

  // Skip = bypass Gmail/Calendar sync, but still ask the user to choose a
  // starter skill so the workspace does not open empty.
  const next = advanceOnboardingStep("dench-cloud", "skill-template", {
    denchCloud: {
      source: "web",
      skipped: true,
      configuredAt: new Date().toISOString(),
    },
  });
  trackServer("onboarding_dench_cloud_skipped");
  return Response.json(next);
}
