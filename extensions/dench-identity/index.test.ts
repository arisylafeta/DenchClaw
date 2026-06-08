import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, afterEach } from "vitest";
import { buildIdentityPrompt, resolveWorkspaceDir } from "./index.ts";
import register from "./index.ts";

function getRegisteredTool(api: { registerTool: ReturnType<typeof vi.fn> }, name: string) {
  return api.registerTool.mock.calls.map((call) => call[0]).find((tool) => tool?.name === name);
}

async function executeTool(
  tool: { execute: (toolCallId: string, input: Record<string, unknown>) => Promise<any> },
  input: Record<string, unknown>,
) {
  return await tool.execute("tool-call-1", input);
}

function mockGatewaySearch(responsePayload: Record<string, unknown>) {
  process.env.DENCH_API_KEY = "dench-test-key";
  process.env.DENCH_GATEWAY_URL = "https://gateway.example.com";
  globalThis.fetch = vi.fn(async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    expect(url).toBe("https://gateway.example.com/v1/composio/tools/search");
    expect(init?.method).toBe("POST");
    return new Response(JSON.stringify(responsePayload), {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    });
  }) as typeof fetch;
}

describe("buildIdentityPrompt", () => {
  const workspaceDir = "/home/user/workspace";

  it("includes chat history path so agent can reference past conversations", () => {
    const prompt = buildIdentityPrompt(workspaceDir);
    expect(prompt).toContain(".openclaw/web-chat/");
    expect(prompt).toContain(path.join(workspaceDir, ".openclaw/web-chat/"));
  });

  it("includes all workspace context paths (prevents agent losing orientation)", () => {
    const prompt = buildIdentityPrompt(workspaceDir);
    expect(prompt).toContain(`**Root**: \`${workspaceDir}\``);
    expect(prompt).toContain(path.join(workspaceDir, "workspace.duckdb"));
    expect(prompt).toContain(path.join(workspaceDir, "skills"));
    expect(prompt).toContain(path.join(workspaceDir, "apps"));
  });

  it("includes CRM skill path for delegation (prevents agent using wrong skill path)", () => {
    const prompt = buildIdentityPrompt(workspaceDir);
    expect(prompt).toContain(path.join(workspaceDir, "skills", "crm", "SKILL.md"));
  });

  it("includes Dench Integrations skill path and guidance", () => {
    const prompt = buildIdentityPrompt(workspaceDir);
    expect(prompt).toContain(path.join(workspaceDir, "skills", "dench-integrations", "SKILL.md"));
    expect(prompt).toContain("Dench Integrations");
    expect(prompt).not.toContain("Composio MCP");
    expect(prompt).toContain("Never");
    expect(prompt).toContain("dench_search_integrations");
    expect(prompt).toContain("dench_execute_integrations");
  });

  it("teaches the agent to emit direct composio connect links for any app", () => {
    const prompt = buildIdentityPrompt(workspaceDir);
    expect(prompt).toContain("ANY third-party app or service");
    expect(prompt).toContain("always call `dench_search_integrations`");
    expect(prompt).toContain("action_link_markdown");
    expect(prompt).toContain("MUST end the assistant reply with that exact markdown link");
    expect(prompt).toContain("dench://composio/connect");
    expect(prompt).toContain("connect_required");
  });

  it("includes enrichment guidance for Apollo and Exa", () => {
    const prompt = buildIdentityPrompt(workspaceDir);
    expect(prompt).toContain("default tool for enrichment requests");
    expect(prompt).toContain('`action: "people"`');
    expect(prompt).toContain('`action: "company"`');
    expect(prompt).toContain('`action: "people_search"`');
    expect(prompt).toContain(
      "Use Apollo for structured CRM enrichment and Exa for broader web research",
    );
  });

  it("prefers Dench Integrations over gog without workspace cache files", () => {
    const prompt = buildIdentityPrompt(workspaceDir);
    expect(prompt).toContain("use the **Dench Integrations** tools directly");
    expect(prompt).toContain("Never use `gog`");
    expect(prompt).toContain("live integration schema");
  });

  it("does not advertise the removed browser skill contract", () => {
    const prompt = buildIdentityPrompt(workspaceDir);
    expect(prompt).not.toContain(path.join(workspaceDir, "skills", "browser", "SKILL.md"));
    expect(prompt).not.toContain("Browser Agent");
  });

  it("includes exec approval policy (prevents agent stalling on exec confirmation)", () => {
    const prompt = buildIdentityPrompt(workspaceDir);
    expect(prompt).toContain("elevated: true");
    expect(prompt).toContain("automatically approved");
  });

  it("references DenchClaw branding, not OpenClaw (prevents identity confusion)", () => {
    const prompt = buildIdentityPrompt(workspaceDir);
    expect(prompt).toContain("You are **DenchClaw**");
    expect(prompt).toContain("always use **DenchClaw** (not OpenClaw)");
  });
});

describe("buildIdentityPrompt composio cache files", () => {
  let tmp: string;
  const originalFetch = globalThis.fetch;
  const originalDenchApiKey = process.env.DENCH_API_KEY;
  const originalDenchGatewayUrl = process.env.DENCH_GATEWAY_URL;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalDenchApiKey !== undefined) {
      process.env.DENCH_API_KEY = originalDenchApiKey;
    } else {
      delete process.env.DENCH_API_KEY;
    }
    if (originalDenchGatewayUrl !== undefined) {
      process.env.DENCH_GATEWAY_URL = originalDenchGatewayUrl;
    } else {
      delete process.env.DENCH_GATEWAY_URL;
    }
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not expose cached tool-index contents in runtime integration guidance", () => {
    tmp = path.join(
      os.tmpdir(),
      `dench-identity-composio-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmp, { recursive: true });
    writeFileSync(
      path.join(tmp, "composio-tool-index.json"),
      JSON.stringify({
        generated_at: "2026-04-01T00:00:00.000Z",
        connected_apps: [
          {
            toolkit_slug: "gmail",
            toolkit_name: "Gmail",
            account_count: 1,
            tools: [
              {
                name: "GMAIL_FETCH_EMAILS",
                title: "Fetch emails",
                description_short: "List inbox messages.",
                required_args: [],
                arg_hints: {
                  label_ids: 'Use ["INBOX"] as JSON array.',
                },
              },
            ],
            recipes: { "Read recent emails": "GMAIL_FETCH_EMAILS" },
          },
        ],
      }),
      "utf-8",
    );

    const prompt = buildIdentityPrompt(tmp);
    expect(prompt).toContain("Connected App Tools (Dench Integrations)");
    expect(prompt).toContain("live integration schema");
    expect(prompt).toContain("dench_search_integrations");
    expect(prompt).not.toContain("GMAIL_FETCH_EMAILS");
  });
});

describe("resolveWorkspaceDir", () => {
  it("returns workspace path when config is a valid string", () => {
    const api = { config: { agents: { defaults: { workspace: "/home/user/ws" } } } };
    expect(resolveWorkspaceDir(api)).toBe("/home/user/ws");
  });

  it("returns undefined when api is null (prevents crash on missing config)", () => {
    expect(resolveWorkspaceDir(null)).toBeUndefined();
  });

  it("returns undefined when api is undefined (prevents crash on missing config)", () => {
    expect(resolveWorkspaceDir(undefined)).toBeUndefined();
  });

  it("returns undefined when config chain is missing (prevents crash on partial config)", () => {
    expect(resolveWorkspaceDir({})).toBeUndefined();
    expect(resolveWorkspaceDir({ config: {} })).toBeUndefined();
    expect(resolveWorkspaceDir({ config: { agents: {} } })).toBeUndefined();
    expect(resolveWorkspaceDir({ config: { agents: { defaults: {} } } })).toBeUndefined();
  });

  it("returns undefined when workspace is empty string (prevents empty path injection)", () => {
    const api = { config: { agents: { defaults: { workspace: "" } } } };
    expect(resolveWorkspaceDir(api)).toBeUndefined();
  });

  it("returns undefined when workspace is whitespace-only (prevents whitespace path injection)", () => {
    const api = { config: { agents: { defaults: { workspace: "   " } } } };
    expect(resolveWorkspaceDir(api)).toBeUndefined();
  });

  it("returns undefined when workspace is not a string (prevents type coercion)", () => {
    expect(
      resolveWorkspaceDir({ config: { agents: { defaults: { workspace: 42 } } } }),
    ).toBeUndefined();
    expect(
      resolveWorkspaceDir({ config: { agents: { defaults: { workspace: true } } } }),
    ).toBeUndefined();
    expect(
      resolveWorkspaceDir({ config: { agents: { defaults: { workspace: null } } } }),
    ).toBeUndefined();
  });

  it("trims leading/trailing whitespace from valid paths", () => {
    const api = { config: { agents: { defaults: { workspace: "  /home/user/ws  " } } } };
    expect(resolveWorkspaceDir(api)).toBe("/home/user/ws");
  });
});

describe("register", () => {
  const originalFetch = globalThis.fetch;
  const originalDenchApiKey = process.env.DENCH_API_KEY;
  const originalDenchGatewayUrl = process.env.DENCH_GATEWAY_URL;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalDenchApiKey !== undefined) {
      process.env.DENCH_API_KEY = originalDenchApiKey;
    } else {
      delete process.env.DENCH_API_KEY;
    }
    if (originalDenchGatewayUrl !== undefined) {
      process.env.DENCH_GATEWAY_URL = originalDenchGatewayUrl;
    } else {
      delete process.env.DENCH_GATEWAY_URL;
    }
  });

  it("hooks into before_prompt_build event when enabled", () => {
    const api = {
      config: { plugins: { entries: {} }, agents: { defaults: { workspace: "/ws" } } },
      on: vi.fn(),
    };
    register(api);
    expect(api.on).toHaveBeenCalledWith("before_prompt_build", expect.any(Function), {
      priority: 100,
    });
  });

  it("does not register handler when plugin is explicitly disabled (respects config)", () => {
    const api = {
      config: { plugins: { entries: { "dench-identity": { config: { enabled: false } } } } },
      on: vi.fn(),
    };
    register(api);
    expect(api.on).not.toHaveBeenCalled();
  });

  it("handler returns system context when workspace is configured", () => {
    const api = {
      config: { plugins: { entries: {} }, agents: { defaults: { workspace: "/ws" } } },
      on: vi.fn(),
    };
    register(api);

    const handler = api.on.mock.calls[0][1];
    const result = handler({}, {});
    expect(result).toEqual({
      prependSystemContext: expect.stringContaining("DenchClaw"),
    });
  });

  it("handler returns undefined when workspace is not configured (prevents empty prompt)", () => {
    const api = {
      config: { plugins: { entries: {} }, agents: { defaults: {} } },
      on: vi.fn(),
    };
    register(api);

    const handler = api.on.mock.calls[0][1];
    const result = handler({}, {});
    expect(result).toBeUndefined();
  });

  it("registers the Dench Integrations search tool when the workspace is configured", () => {
    const tmp = path.join(
      os.tmpdir(),
      `dench-identity-register-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(path.join(tmp, "skills", "dench-integrations"), { recursive: true });
    writeFileSync(
      path.join(tmp, "skills", "dench-integrations", "SKILL.md"),
      "# Dench Integrations connected apps\n",
      "utf-8",
    );

    const api = {
      config: { plugins: { entries: {} }, agents: { defaults: { workspace: tmp } } },
      on: vi.fn(),
      registerTool: vi.fn(),
    };

    register(api as any);

    expect(api.registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "dench_search_integrations" }),
      { name: "dench_search_integrations", optional: true },
    );
    expect(getRegisteredTool(api as any, "dench_execute_integrations")).toBeUndefined();

    rmSync(tmp, { recursive: true, force: true });
  });

  it("searches GitHub integration tools for recent PR requests", async () => {
    const tmp = path.join(
      os.tmpdir(),
      `dench-identity-github-search-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmp, { recursive: true });
    mockGatewaySearch({
      items: [
        {
          slug: "GITHUB_FIND_PULL_REQUESTS",
          name: "Find pull requests",
          description: "Find GitHub pull requests.",
          toolkit: {
            slug: "github",
            name: "GitHub",
          },
          input_parameters: {
            type: "object",
            properties: {
              state: {
                type: "string",
              },
            },
          },
          connection_status: {
            is_connected: true,
            account_count: 1,
            accounts: [],
          },
        },
      ],
      connected_toolkits: ["github"],
    });

    const api = {
      config: { plugins: { entries: {} }, agents: { defaults: { workspace: tmp } } },
      on: vi.fn(),
      registerTool: vi.fn(),
    };

    register(api as any);

    const searchTool = getRegisteredTool(api as any, "dench_search_integrations");
    const result = await executeTool(searchTool, {
      toolkit: "github",
      query: "check my recent PRs",
    });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.toolkit_filter).toBe("github");
    expect(payload.result_count).toBe(1);
    expect(payload.results[0].tool_slug).toBe("GITHUB_FIND_PULL_REQUESTS");
    expect(payload.instruction).toContain("dench_execute_integrations");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("searches across connected apps and ranks the best tool matches", async () => {
    const tmp = path.join(
      os.tmpdir(),
      `dench-identity-search-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmp, { recursive: true });
    mockGatewaySearch({
      items: [
        {
          slug: "STRIPE_LIST_SUBSCRIPTIONS",
          name: "List subscriptions",
          description: "List Stripe subscriptions for billing analysis.",
          toolkit: {
            slug: "stripe",
            name: "Stripe",
          },
          input_parameters: { type: "object", properties: {} },
          connection_status: {
            is_connected: true,
            account_count: 1,
            accounts: [],
          },
        },
        {
          slug: "GITHUB_FIND_PULL_REQUESTS",
          name: "Find pull requests",
          description: "Find GitHub pull requests.",
          toolkit: {
            slug: "github",
            name: "GitHub",
          },
          input_parameters: { type: "object", properties: {} },
          connection_status: {
            is_connected: true,
            account_count: 1,
            accounts: [],
          },
        },
      ],
      connected_toolkits: ["stripe", "github"],
    });

    const api = {
      config: { plugins: { entries: {} }, agents: { defaults: { workspace: tmp } } },
      on: vi.fn(),
      registerTool: vi.fn(),
    };

    register(api as any);

    const searchTool = getRegisteredTool(api as any, "dench_search_integrations");
    const result = await executeTool(searchTool, {
      query: "find billing subscriptions for a customer",
    });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.result_count).toBeGreaterThan(0);
    expect(payload.results[0].tool_slug).toBe("STRIPE_LIST_SUBSCRIPTIONS");
    expect(payload.results[1].tool_slug).toBe("GITHUB_FIND_PULL_REQUESTS");
    expect(payload.results[0].toolkit.slug).toBe("stripe");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns gateway-backed Dench Integrations search results with full schemas", async () => {
    const tmp = path.join(
      os.tmpdir(),
      `dench-identity-gateway-search-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmp, { recursive: true });
    writeFileSync(
      path.join(tmp, "composio-tool-index.json"),
      JSON.stringify({
        generated_at: "2026-04-03T00:00:00.000Z",
        managed_tools: ["dench_search_integrations", "dench_execute_integrations"],
        connected_apps: [
          {
            toolkit_slug: "stripe",
            toolkit_name: "Stripe",
            account_count: 1,
            tools: [
              {
                name: "STRIPE_LIST_SUBSCRIPTIONS",
                title: "List subscriptions",
                description_short: "List Stripe subscriptions.",
                required_args: [],
                arg_hints: {},
              },
            ],
            recipes: {
              "List subscriptions": "STRIPE_LIST_SUBSCRIPTIONS",
            },
          },
        ],
      }),
      "utf-8",
    );

    process.env.DENCH_API_KEY = "dench-test-key";
    process.env.DENCH_GATEWAY_URL = "https://gateway.example.com";
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      expect(url).toBe("https://gateway.example.com/v1/composio/tools/search");
      expect(init?.method).toBe("POST");
      return new Response(
        JSON.stringify({
          items: [
            {
              slug: "STRIPE_LIST_SUBSCRIPTIONS",
              name: "List subscriptions",
              description: "List subscriptions.",
              toolkit: {
                slug: "stripe",
                name: "Stripe",
              },
              input_parameters: {
                type: "object",
                properties: {
                  limit: { type: "number" },
                  starting_after: { type: "string" },
                },
              },
              connection_status: {
                is_connected: true,
                account_count: 1,
                accounts: [
                  {
                    id: "acct_primary",
                    alias: "Primary Stripe",
                    is_default: true,
                    user_info: {
                      email: "ops@example.com",
                      name: "Primary Stripe",
                    },
                  },
                ],
              },
            },
          ],
          connected_toolkits: ["stripe"],
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    }) as typeof fetch;

    const api = {
      config: {
        plugins: {
          entries: {
            "dench-ai-gateway": {
              config: {
                gatewayUrl: "https://gateway.example.com",
              },
            },
          },
        },
        agents: { defaults: { workspace: tmp } },
      },
      on: vi.fn(),
      registerTool: vi.fn(),
    };

    register(api as any);

    const searchTool = getRegisteredTool(api as any, "dench_search_integrations");
    const result = await executeTool(searchTool, {
      toolkit: "stripe",
      query: "list Stripe subscriptions for billing analysis",
    });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.result_count).toBe(1);
    expect(payload.results[0].tool_slug).toBe("STRIPE_LIST_SUBSCRIPTIONS");
    expect(payload.results[0].input_schema.properties.starting_after).toBeTruthy();
    expect(payload.results[0].accounts).toHaveLength(1);

    rmSync(tmp, { recursive: true, force: true });
  });

  it("requires account selection when multiple connected accounts match the same app", async () => {
    const tmp = path.join(
      os.tmpdir(),
      `dench-identity-multi-account-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmp, { recursive: true });
    mockGatewaySearch({
      items: [
        {
          slug: "STRIPE_LIST_SUBSCRIPTIONS",
          name: "List subscriptions",
          description: "List subscriptions.",
          toolkit: {
            slug: "stripe",
            name: "Stripe",
          },
          input_parameters: { type: "object", properties: {} },
          connection_status: {
            is_connected: true,
            account_count: 2,
            accounts: [
              {
                id: "acct_prod",
                alias: "Prod Stripe",
                user_info: {
                  email: "ops@example.com",
                  name: "Prod Stripe",
                },
              },
              {
                id: "acct_test",
                alias: "Test Stripe",
                user_info: {
                  email: "dev@example.com",
                  name: "Test Stripe",
                },
              },
            ],
          },
        },
      ],
      connected_toolkits: ["stripe"],
    });

    const api = {
      config: { plugins: { entries: {} }, agents: { defaults: { workspace: tmp } } },
      on: vi.fn(),
      registerTool: vi.fn(),
    };

    register(api as any);

    const searchTool = getRegisteredTool(api as any, "dench_search_integrations");
    const result = await executeTool(searchTool, {
      toolkit: "stripe",
      query: "list subscriptions",
    });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.results[0].account_count).toBe(2);
    expect(payload.results[0].accounts).toHaveLength(2);
    expect(payload.instruction).toContain("multiple connected accounts");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("forwards toolkit and limit filters to gateway-backed searches", async () => {
    const tmp = path.join(
      os.tmpdir(),
      `dench-identity-filtered-search-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmp, { recursive: true });
    process.env.DENCH_API_KEY = "dench-test-key";
    process.env.DENCH_GATEWAY_URL = "https://gateway.example.com";

    globalThis.fetch = vi.fn(async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      expect(url).toBe("https://gateway.example.com/v1/composio/tools/search");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body ?? "{}"))).toMatchObject({
        query: "list Stripe subscriptions",
        toolkit_slug: "stripe",
        limit: 5,
      });
      return new Response(
        JSON.stringify({
          items: [
            {
              slug: "STRIPE_LIST_SUBSCRIPTIONS",
              name: "List subscriptions",
              description: "List subscriptions.",
              toolkit: {
                slug: "stripe",
                name: "Stripe",
              },
              input_parameters: { type: "object", properties: {} },
              connection_status: {
                is_connected: true,
                account_count: 1,
                accounts: [],
              },
            },
          ],
          connected_toolkits: ["stripe"],
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    }) as typeof fetch;

    const api = {
      config: { plugins: { entries: {} }, agents: { defaults: { workspace: tmp } } },
      on: vi.fn(),
      registerTool: vi.fn(),
    };

    register(api as any);

    const searchTool = getRegisteredTool(api as any, "dench_search_integrations");
    const result = await executeTool(searchTool, {
      toolkit: "stripe",
      limit: 5,
      query: "list Stripe subscriptions",
    });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.toolkit_filter).toBe("stripe");
    expect(payload.result_count).toBe(1);

    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns static fallback recipes when a connected toolkit search has no gateway matches", async () => {
    const tmp = path.join(
      os.tmpdir(),
      `dench-identity-no-match-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmp, { recursive: true });
    mockGatewaySearch({
      items: [],
      connected_toolkits: ["gmail"],
    });

    const api = {
      config: { plugins: { entries: {} }, agents: { defaults: { workspace: tmp } } },
      on: vi.fn(),
      registerTool: vi.fn(),
    };

    register(api as any);

    const searchTool = getRegisteredTool(api as any, "dench_search_integrations");
    const result = await executeTool(searchTool, {
      toolkit: "gmail",
      query: "read my recent email",
    });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.result_count).toBe(1);
    expect(payload.results[0].tool_slug).toBe("GMAIL_FETCH_EMAILS");
    expect(payload.results[0].suggested_arguments).toEqual({
      label_ids: ["INBOX"],
      max_results: 10,
    });
    expect(payload.search_source).toBe("static_recipe_fallback");
    expect(payload.connected_toolkits).toEqual(["gmail"]);
    expect(payload.instruction).toContain("dench_execute_integrations");
    expect(payload.instruction).toContain("Do NOT stop");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns a direct connect link when the requested app is not connected", async () => {
    const tmp = path.join(
      os.tmpdir(),
      `dench-identity-connect-required-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmp, { recursive: true });
    mockGatewaySearch({
      items: [],
      connected_toolkits: [],
    });

    const api = {
      config: { plugins: { entries: {} }, agents: { defaults: { workspace: tmp } } },
      on: vi.fn(),
      registerTool: vi.fn(),
    };

    register(api as any);

    const searchTool = getRegisteredTool(api as any, "dench_search_integrations");
    const result = await executeTool(searchTool, {
      toolkit: "slack",
      query: "check my slack",
    });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.availability).toBe("connect_required");
    expect(payload.action_required).toBe("connect");
    expect(payload.toolkit_slug).toBe("slack");
    expect(payload.action_link_markdown).toBe(
      "[Connect Slack](dench://composio/connect?toolkit=slack&name=Slack)",
    );

    rmSync(tmp, { recursive: true, force: true });
  });
});
