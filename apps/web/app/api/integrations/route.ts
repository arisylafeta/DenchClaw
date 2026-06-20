import {
  type IntegrationsState,
  normalizeLockedDenchIntegrations,
} from "@/lib/integrations";
import { readHermesMcpAuthority } from "@/lib/hermes-mcp-authority";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type HermesWrappedIntegrationsState = IntegrationsState & {
  managedByHermes?: boolean;
  readOnly?: boolean;
  summary?: {
    owner: "hermes";
    message: string;
  };
  legacyManagedPlugins?: {
    disabled: true;
    archived: true;
    message: string;
    items: unknown[];
    wouldUse: string;
  };
  ownershipNotes?: {
    exa: string;
    apollo: string;
  };
};

async function applyHermesAuthority(
  state: IntegrationsState,
): Promise<HermesWrappedIntegrationsState> {
  const authority = await readHermesMcpAuthority();
  if (authority.servers.length === 0) {
    return state;
  }

  const wrapped = state as HermesWrappedIntegrationsState;
  const archivedPlugins = wrapped.managedPlugins.map((plugin) => ({
    ...plugin,
    archived: true,
    available: false,
    healthIssues: [],
    health: {
      ...plugin.health,
      status: "archived",
      pluginMissing: false,
      pluginInstalledButDisabled: false,
      configMismatch: false,
      missingAuth: false,
      missingGatewayOverride: false,
    },
    summary: {
      level: "archived",
      verified: false,
      message:
        "Retained for audit only. Hermes MCP is the active integration authority; this legacy Dench plugin entry is not a live remediation target.",
    },
    legacyEvidence: plugin.healthIssues,
  }));

  wrapped.managedByHermes = true;
  wrapped.readOnly = true;
  wrapped.metadata = {
    ...wrapped.metadata,
    mcpAuthority: authority,
  } as IntegrationsState["metadata"];
  wrapped.managedPlugins = [];
  wrapped.summary = {
    owner: "hermes",
    message:
      "Hermes MCP config is the active integration authority. Dench exposes integrations here as a read-only client surface backed by Hermes.",
  };
  wrapped.legacyManagedPlugins = {
    disabled: true,
    archived: true,
    message:
      "Archived legacy Dench plugin metadata is retained for audit only. Hermes MCP is the active integration authority.",
    items: archivedPlugins,
    wouldUse: "Dench plugin health control plane",
  };
  wrapped.ownershipNotes = {
    exa: "Exa is surfaced from its standalone Hermes MCP server entry.",
    apollo:
      "Apollo is surfaced through the Hermes-managed denchclaw MCP adapter rather than a standalone Hermes MCP server entry.",
  };

  for (const integration of wrapped.integrations as Array<Record<string, any>>) {
    const isExaHermesManaged = integration.id === "exa" && authority.servers.includes("exa");
    const isApolloHermesManaged =
      integration.id === "apollo" && authority.servers.includes("denchclaw");

    if (isExaHermesManaged || isApolloHermesManaged) {
      integration.enabled = true;
      integration.available = true;
      integration.locked = false;
      integration.lockReason = null;
      integration.lockBadge = isApolloHermesManaged
        ? "Managed by Hermes DenchClaw MCP"
        : "Managed by Hermes MCP";
      integration.managedByDench = false;
      integration.managedByHermes = true;
      integration.gatewayBaseUrl = null;
      integration.auth = {
        configured: true,
        source: isApolloHermesManaged ? "hermes-mcp-denchclaw" : "hermes-mcp",
      };
      integration.health = {
        ...integration.health,
        status: "healthy",
        pluginMissing: false,
        pluginInstalledButDisabled: false,
        missingAuth: false,
        configMismatch: false,
        missingGatewayOverride: false,
      };
      integration.healthIssues = [];
      integration.managedVia = isApolloHermesManaged
        ? "denchclaw-mcp-tool"
        : "standalone-hermes-mcp";
      integration.managedByServer = isApolloHermesManaged ? "denchclaw" : "exa";
    }

    if (integration.id === "elevenlabs") {
      integration.enabled = false;
      integration.available = false;
      integration.locked = true;
      integration.lockReason = "no_hermes_mcp_evidence";
      integration.lockBadge = "No Hermes MCP evidence configured";
      integration.managedByDench = false;
      integration.managedByHermes = false;
      integration.gatewayBaseUrl = null;
      integration.auth = {
        configured: false,
        source: "hermes-mcp-missing",
      };
      integration.health = {
        ...integration.health,
        status: "disabled",
        missingAuth: false,
        configMismatch: false,
        missingGatewayOverride: false,
      };
      integration.healthIssues = ["no_hermes_mcp_evidence"];
      integration.overrideActive = false;
    }
  }

  return wrapped;
}

export async function GET() {
  return Response.json(await applyHermesAuthority(normalizeLockedDenchIntegrations().state));
}
