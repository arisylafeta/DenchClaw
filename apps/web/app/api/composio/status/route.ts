import { getComposioMcpHealth } from "@/lib/composio-mcp-health";
import { formatDenchIntegrationsStatusError } from "@/lib/dench-integrations-brand";
import {
  isHermesDenchClawMcpAuthority,
  readHermesMcpAuthority,
} from "@/lib/hermes-mcp-authority";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type PostBody = {
  action?: "refresh_status" | "repair_mcp" | "probe_live_agent";
};

async function applyHermesAuthority(status: Record<string, unknown>) {
  const authority = await readHermesMcpAuthority();
  if (!isHermesDenchClawMcpAuthority(authority)) {
    return status;
  }

  const generatedAt = typeof status.generatedAt === "string"
    ? status.generatedAt
    : new Date().toISOString();

  return {
    ...status,
    managedByHermes: true,
    readOnly: true,
    metadata: {
      ...(
        status.metadata && typeof status.metadata === "object" && !Array.isArray(status.metadata)
          ? status.metadata
          : {}
      ),
      mcpAuthority: authority,
    },
    legacyDenchCloud: {
      gatewayUrl: status.gatewayUrl,
      eligible: status.eligible,
      lockReason: status.lockReason,
      lockBadge: status.lockBadge,
      config: status.config,
      gatewayTools: status.gatewayTools,
      summary: {
        level: "archived",
        verified: false,
        message:
          "Legacy ReBattery Cloud status is retained for audit only and is not the active integration authority under Hermes MCP.",
      },
    },
    gatewayUrl: null,
    eligible: true,
    lockReason: null,
    lockBadge: "Managed by Hermes ReBattery CRM MCP",
    config: {
      status: "pass",
      detail:
        "Hermes config registers the ReBattery CRM MCP adapter; ReBattery Cloud gateway config is not the integration authority.",
      checkedAt: generatedAt,
      matchesExpected: true,
      configured: {
        owner: "hermes",
        configPath: authority.configPath,
        server: "denchclaw",
      },
      expected: {
        owner: "hermes",
        configPath: authority.configPath,
        server: "denchclaw",
      },
    },
    gatewayTools: {
      status: "unknown",
      detail: "ReBattery Cloud gateway probe was skipped because Hermes MCP is the integration authority.",
      checkedAt: generatedAt,
      toolCount: null,
    },
    summary: {
      level: "healthy",
      verified: false,
      message:
        "ReBattery Integrations are managed through the Hermes ReBattery CRM MCP adapter; ReBattery Cloud gateway is not required for the Hermes-backed Exa and Apollo integrations.",
    },
    managedVia: "denchclaw-mcp-tool",
    managedByServer: "denchclaw",
    ownershipNote:
      "This status surface is backed by the Hermes-managed ReBattery CRM MCP adapter rather than a standalone ReBattery Cloud gateway authority.",
  };
}

export async function GET() {
  try {
    const status = await getComposioMcpHealth({ autoRepairConfig: true });
    return Response.json(await applyHermesAuthority(status as Record<string, unknown>));
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : formatDenchIntegrationsStatusError("load"),
      },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  try {
    if (!body.action || body.action === "refresh_status") {
      return Response.json(await applyHermesAuthority(
        await getComposioMcpHealth({ autoRepairConfig: true }) as Record<string, unknown>,
      ));
    }
    if (body.action === "repair_mcp") {
      return Response.json(await applyHermesAuthority(
        await getComposioMcpHealth({
          repairConfig: true,
          includeLiveAgentProbe: true,
        }) as Record<string, unknown>,
      ));
    }
    if (body.action === "probe_live_agent") {
      return Response.json(await applyHermesAuthority(
        await getComposioMcpHealth({
          autoRepairConfig: true,
          includeLiveAgentProbe: true,
        }) as Record<string, unknown>,
      ));
    }
    return Response.json(
      { error: "Unknown action. Use 'refresh_status', 'repair_mcp', or 'probe_live_agent'." },
      { status: 400 },
    );
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : formatDenchIntegrationsStatusError("update"),
      },
      { status: 500 },
    );
  }
}
