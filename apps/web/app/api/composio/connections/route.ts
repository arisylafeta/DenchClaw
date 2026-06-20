import {
  type ComposioConnectionsResponse,
  type ComposioToolkit,
  fetchComposioConnections,
  fetchComposioToolkits,
  resolveComposioApiKey,
  resolveComposioEligibility,
  resolveComposioGatewayUrl,
} from "@/lib/composio";
import {
  extractComposioConnections,
  extractComposioToolkits,
  normalizeComposioConnections,
} from "@/lib/composio-client";
import {
  normalizeComposioToolkitName,
  normalizeComposioToolkitSlug,
} from "@/lib/composio-normalization";
import {
  isHermesDenchClawMcpAuthority,
  readHermesMcpAuthority,
} from "@/lib/hermes-mcp-authority";
import {
  fetchBulkToolkitsCached as fetchBulkToolkitsThroughCache,
  fetchConnectionsCached as fetchConnectionsThroughCache,
  fetchResolvedToolkitsCached,
} from "./cache";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CONNECTED_TOOLKIT_BULK_LIMIT = 100;

function createToolkitPlaceholder(slug: string, name: string): ComposioToolkit {
  return {
    slug,
    connect_slug: slug,
    name: normalizeComposioToolkitName(name, slug),
    description: "",
    logo: null,
    categories: [],
    auth_schemes: [],
    tools_count: 0,
  };
}

async function fetchConnectionsCached(
  gatewayUrl: string,
  apiKey: string,
): Promise<ComposioConnectionsResponse> {
  return await fetchConnectionsThroughCache(
    gatewayUrl,
    apiKey,
    async () => await fetchComposioConnections(gatewayUrl, apiKey),
  );
}

async function fetchBulkToolkitsCached(
  gatewayUrl: string,
  apiKey: string,
): Promise<ComposioToolkit[]> {
  return await fetchBulkToolkitsThroughCache(
    gatewayUrl,
    apiKey,
    async () => extractComposioToolkits(await fetchComposioToolkits(gatewayUrl, apiKey, {
      limit: CONNECTED_TOOLKIT_BULK_LIMIT,
    })).items,
  );
}

async function resolveConnectedToolkits(
  gatewayUrl: string,
  apiKey: string,
  connections: ComposioConnectionsResponse,
  preFetchedBulkToolkits?: ComposioToolkit[],
): Promise<ComposioToolkit[]> {
  const normalizedConnections = normalizeComposioConnections(
    extractComposioConnections(connections),
  );
  const activeConnections = normalizedConnections.filter((connection) => connection.is_active);
  const activeSlugs = Array.from(
    new Set(activeConnections.map((connection) => connection.normalized_toolkit_slug)),
  );

  if (activeSlugs.length === 0) {
    return [];
  }

  return await fetchResolvedToolkitsCached(
    gatewayUrl,
    apiKey,
    activeSlugs,
    async () => {
      const bulkToolkits = preFetchedBulkToolkits
        ?? await fetchBulkToolkitsCached(gatewayUrl, apiKey).catch(() => []);
      const bulkToolkitsBySlug = new Map<string, ComposioToolkit>();
      for (const toolkit of bulkToolkits) {
        const normalizedSlug = normalizeComposioToolkitSlug(toolkit.slug);
        if (!bulkToolkitsBySlug.has(normalizedSlug)) {
          bulkToolkitsBySlug.set(normalizedSlug, toolkit);
        }
      }

      const toolkits = activeSlugs.map((slug) => {
        const bulkMatch = bulkToolkitsBySlug.get(slug);
        if (bulkMatch) {
          return bulkMatch;
        }

        const fallbackName = activeConnections.find((connection) =>
          connection.normalized_toolkit_slug === slug)?.toolkit_name ?? slug;
        return createToolkitPlaceholder(slug, fallbackName);
      });

      return [...toolkits]
        .toSorted((left, right) => left.name.localeCompare(right.name));
    },
  );
}

export async function GET(request: Request) {
  const authority = await readHermesMcpAuthority();
  if (isHermesDenchClawMcpAuthority(authority)) {
    const includeToolkits = new URL(request.url).searchParams.get("include_toolkits") === "1";
    return Response.json({
      connections: [],
      items: [],
      ...(includeToolkits ? { toolkits: [] } : {}),
      managedByHermes: true,
      readOnly: true,
      metadata: {
        mcpAuthority: authority,
      },
      legacyConnections: {
        disabled: true,
        wouldUse: "Legacy Dench Cloud Composio connection list",
      },
    });
  }

  const apiKey = resolveComposioApiKey();
  if (!apiKey) {
    return Response.json(
      { error: "Dench Cloud API key is required." },
      { status: 403 },
    );
  }

  const eligibility = resolveComposioEligibility();
  if (!eligibility.eligible) {
    return Response.json(
      {
        error: "Dench Cloud must be the primary provider.",
        lockReason: eligibility.lockReason,
        lockBadge: eligibility.lockBadge,
      },
      { status: 403 },
    );
  }

  const gatewayUrl = resolveComposioGatewayUrl();
  const searchParams = new URL(request.url).searchParams;
  const includeToolkits = searchParams.get("include_toolkits") === "1";
  const fresh = searchParams.get("fresh") === "1";

  try {
    if (includeToolkits) {
      const connectionsPromise = fresh
        ? fetchComposioConnections(gatewayUrl, apiKey)
        : fetchConnectionsCached(gatewayUrl, apiKey);
      const [data, bulkToolkits] = await Promise.all([
        connectionsPromise,
        fetchBulkToolkitsCached(gatewayUrl, apiKey).catch(() => []),
      ]);
      return Response.json({
        ...data,
        toolkits: await resolveConnectedToolkits(gatewayUrl, apiKey, data, bulkToolkits),
      });
    }
    const data = fresh
      ? await fetchComposioConnections(gatewayUrl, apiKey)
      : await fetchConnectionsCached(gatewayUrl, apiKey);
    return Response.json(data);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to fetch connections." },
      { status: 502 },
    );
  }
}
