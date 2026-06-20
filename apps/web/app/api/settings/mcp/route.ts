import {
  type HermesMcpAuthority,
  readHermesMcpAuthority,
} from "@/lib/hermes-mcp-authority";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type McpSettingsBody = {
  key?: unknown;
  url?: unknown;
  transport?: unknown;
};

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

function legacyState(authority: HermesMcpAuthority) {
  return {
    servers: [],
    readOnly: true,
    managedByHermes: true,
    metadata: {
      mcpAuthority: authority,
    },
    summary: {
      owner: "hermes",
      message:
        "Hermes MCP config is the active MCP authority. Dench MCP settings are legacy and exposed here as a read-only client surface.",
    },
    legacyDenchMcp: {
      disabled: true,
      archived: true,
      wouldMutate: ["Dench MCP server registry"],
      servers: [],
    },
  };
}

export async function GET(): Promise<Response> {
  try {
    return Response.json(legacyState(await readHermesMcpAuthority()));
  } catch (err) {
    return jsonError(
      err instanceof Error ? err.message : "Failed to load MCP servers.",
      500,
    );
  }
}

export async function POST(req: Request): Promise<Response> {
  let body: McpSettingsBody;
  try {
    body = (await req.json()) as McpSettingsBody;
  } catch {
    return jsonError("Invalid JSON body.", 400);
  }

  if (typeof body.key !== "string") {
    return jsonError("Field 'key' must be a string.", 400);
  }
  if (typeof body.url !== "string") {
    return jsonError("Field 'url' must be a string.", 400);
  }
  if (body.transport !== undefined && typeof body.transport !== "string") {
    return jsonError("Field 'transport' must be a string.", 400);
  }

  return Response.json(
    {
      error: "legacy_mcp_settings",
      message:
        "Hermes MCP config is the integration authority; Dench MCP settings are legacy and read-only until ownership is proven.",
      changed: false,
      readOnly: true,
      managedByHermes: true,
      metadata: {
        mcpAuthority: await readHermesMcpAuthority(),
      },
      legacyDenchMcp: {
        disabled: true,
        archived: true,
        wouldMutate: ["Dench MCP server registry"],
      },
    },
    { status: 409 },
  );
}

export async function DELETE(req: Request): Promise<Response> {
  let body: Pick<McpSettingsBody, "key">;
  try {
    body = (await req.json()) as Pick<McpSettingsBody, "key">;
  } catch {
    return jsonError("Invalid JSON body.", 400);
  }

  if (typeof body.key !== "string") {
    return jsonError("Field 'key' must be a string.", 400);
  }

  return Response.json(
    {
      error: "legacy_mcp_settings",
      message:
        "Hermes MCP config is the integration authority; Dench MCP settings are legacy and read-only until ownership is proven.",
      changed: false,
      readOnly: true,
      managedByHermes: true,
      metadata: {
        mcpAuthority: await readHermesMcpAuthority(),
      },
      legacyDenchMcp: {
        disabled: true,
        archived: true,
        wouldMutate: ["Dench MCP server registry"],
      },
    },
    { status: 409 },
  );
}
