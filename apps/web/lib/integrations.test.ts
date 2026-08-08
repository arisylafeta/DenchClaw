import type { ExecFileException, ExecFileOptions } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";

const requireFs = createRequire(import.meta.url);
const realFs = requireFs("node:fs") as typeof import("node:fs");

function resolveBundledExtensionSourcePath(pluginId: string): string {
  return join("/fake/repo/root", "extensions", pluginId);
}

vi.mock("@/lib/runtime-roots", () => ({
  resolveBundledExtensionsRoot: vi.fn(() => "/fake/repo/root"),
}));

vi.mock("@/lib/workspace", () => ({
  resolveOpenClawStateDir: vi.fn(() => "/home/testuser/.openclaw-dench"),
}));

vi.mock("node:fs", () => ({
  cpSync: vi.fn(),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(() => ""),
  writeFileSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: vi.fn((_file, _args, _options, callback) => {
    if (typeof _options === "function") {
      _options(null, "", "");
      return;
    }
    callback?.(null, "", "");
  }),
}));

describe("integrations state", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("normalizes Dench integration and search ownership state", async () => {
    const { existsSync, readFileSync } = await import("node:fs");
    const mockExists = vi.mocked(existsSync);
    const mockRead = vi.mocked(readFileSync);

    mockExists.mockImplementation((path) => {
      const value = String(path);
      return (
        value.endsWith("openclaw.json") ||
        value.endsWith(".dench-integrations.json") ||
        value === "/home/testuser/.openclaw-dench/extensions/exa-search" ||
        value === "/home/testuser/.openclaw-dench/extensions/apollo-enrichment"
      );
    });

    mockRead.mockImplementation((path) => {
      const value = String(path);
      if (value.endsWith("openclaw.json")) {
        return JSON.stringify({
          agents: {
            defaults: {
              model: {
                primary: "dench-cloud/claude-sonnet-4.6",
              },
            },
          },
          models: {
            providers: {
              "dench-cloud": {
                apiKey: "dench-key",
              },
            },
          },
          messages: {
            tts: {
              provider: "elevenlabs",
              providers: {
                elevenlabs: {
                  baseUrl: "https://gateway.merseoriginals.com",
                  apiKey: "dench-key",
                },
              },
            },
          },
          plugins: {
            allow: ["exa-search", "apollo-enrichment"],
            load: {
              paths: [
                "/home/testuser/.openclaw-dench/extensions/exa-search",
                "/home/testuser/.openclaw-dench/extensions/apollo-enrichment",
              ],
            },
            entries: {
              "dench-ai-gateway": {
                enabled: true,
                config: {
                  gatewayUrl: "https://gateway.merseoriginals.com",
                },
              },
              "exa-search": {
                enabled: true,
              },
              "apollo-enrichment": {
                enabled: true,
              },
            },
            installs: {
              "exa-search": {
                installPath: "/home/testuser/.openclaw-dench/extensions/exa-search",
                sourcePath: "/repo/extensions/exa-search",
              },
              "apollo-enrichment": {
                installPath: "/home/testuser/.openclaw-dench/extensions/apollo-enrichment",
                sourcePath: "/repo/extensions/apollo-enrichment",
              },
            },
          },
          tools: {
            deny: ["web_search"],
            web: {
              search: {
                enabled: false,
                provider: "brave",
              },
            },
          },
        }) as never;
      }

      if (value.endsWith(".dench-integrations.json")) {
        return JSON.stringify({
          schemaVersion: 1,
          exa: {
            ownsSearch: true,
            fallbackProvider: "duckduckgo",
          },
        }) as never;
      }

      return "" as never;
    });

    const { getIntegrationsState } = await import("./integrations.js");
    const state = getIntegrationsState();
    expect(state.search).toEqual({
      builtIn: {
        enabled: false,
        denied: true,
        provider: "brave",
      },
      effectiveOwner: "exa",
    });
    expect(state.metadata.exa).toEqual({
      ownsSearch: true,
      fallbackProvider: "duckduckgo",
    });

    const exa = state.integrations.find((integration) => integration.id === "exa");
    const elevenlabs = state.integrations.find((integration) => integration.id === "elevenlabs");
    expect(exa).toMatchObject({
      enabled: true,
      available: true,
      gatewayBaseUrl: "https://gateway.merseoriginals.com",
      healthIssues: [],
      health: {
        status: "healthy",
        pluginMissing: false,
        pluginInstalledButDisabled: false,
        configMismatch: false,
        missingAuth: false,
        missingGatewayOverride: false,
      },
    });
    expect(elevenlabs).toMatchObject({
      enabled: true,
      available: true,
      overrideActive: true,
      healthIssues: [],
      health: {
        status: "healthy",
        missingGatewayOverride: false,
      },
    });
  });

  it("reports missing override and falls back to built-in search", async () => {
    const { existsSync, readFileSync } = await import("node:fs");
    const mockExists = vi.mocked(existsSync);
    const mockRead = vi.mocked(readFileSync);

    mockExists.mockImplementation((path) => String(path).endsWith("openclaw.json"));
    mockRead.mockImplementation((path) => {
      if (String(path).endsWith("openclaw.json")) {
        return JSON.stringify({
          plugins: {
            entries: {
              "exa-search": {
                enabled: false,
              },
            },
          },
          tools: {
            web: {
              search: {
                enabled: true,
                provider: "duckduckgo",
              },
            },
          },
        }) as never;
      }

      return "" as never;
    });

    const { getIntegrationsState } = await import("./integrations.js");
    const state = getIntegrationsState();
    expect(state.search.effectiveOwner).toBe("web_search");

    const exa = state.integrations.find((integration) => integration.id === "exa");
    const elevenlabs = state.integrations.find((integration) => integration.id === "elevenlabs");
    expect(exa?.healthIssues).toEqual(
      expect.arrayContaining([
        "plugin_disabled",
        "plugin_not_allowlisted",
        "plugin_load_path_missing",
        "plugin_install_missing",
        "missing_auth",
      ]),
    );
    expect(elevenlabs?.healthIssues).toEqual(
      expect.arrayContaining(["missing_auth", "missing_api_key", "missing_override"]),
    );
    expect(exa?.health).toMatchObject({
      status: "disabled",
      pluginMissing: true,
      pluginInstalledButDisabled: true,
      configMismatch: true,
      missingAuth: true,
    });
    expect(elevenlabs?.health).toMatchObject({
      status: "disabled",
      missingAuth: true,
      missingGatewayOverride: true,
    });
  });

  it("locks Dench integrations without a Dench key", async () => {
    const { existsSync, readFileSync } = await import("node:fs");
    const mockExists = vi.mocked(existsSync);
    const mockRead = vi.mocked(readFileSync);

    mockExists.mockImplementation((path) => String(path).endsWith("openclaw.json"));
    mockRead.mockImplementation((path) => {
      if (String(path).endsWith("openclaw.json")) {
        return JSON.stringify({
          agents: {
            defaults: {
              model: {
                primary: "anthropic/claude-4",
              },
            },
          },
          plugins: {
            entries: {
              "exa-search": { enabled: true },
              "apollo-enrichment": { enabled: true },
            },
          },
          messages: {
            tts: {
              provider: "elevenlabs",
              providers: {
                elevenlabs: {
                  baseUrl: "https://gateway.merseoriginals.com",
                },
              },
            },
          },
        }) as never;
      }

      return "" as never;
    });

    const { getIntegrationsState } = await import("./integrations.js");
    const state = getIntegrationsState();
    expect(state.denchCloud).toEqual({
      hasKey: false,
      isPrimaryProvider: false,
      primaryModel: "anthropic/claude-4",
    });
    for (const integration of state.integrations) {
      expect(integration.locked).toBe(true);
      expect(integration.lockReason).toBe("missing_dench_key");
      expect(integration.lockBadge).toBe("Get ReBattery Cloud API Key");
      expect(integration.enabled).toBe(false);
    }
  });

  it("locks Dench integrations when ReBattery Cloud is not primary", async () => {
    const { existsSync, readFileSync } = await import("node:fs");
    const mockExists = vi.mocked(existsSync);
    const mockRead = vi.mocked(readFileSync);

    mockExists.mockImplementation((path) => String(path).endsWith("openclaw.json"));
    mockRead.mockImplementation((path) => {
      if (String(path).endsWith("openclaw.json")) {
        return JSON.stringify({
          agents: {
            defaults: {
              model: {
                primary: "anthropic/claude-4",
              },
            },
          },
          models: {
            providers: {
              "dench-cloud": {
                apiKey: "dench-key",
              },
            },
          },
          plugins: {
            entries: {
              "exa-search": { enabled: true },
            },
          },
        }) as never;
      }

      return "" as never;
    });

    const { getIntegrationsState } = await import("./integrations.js");
    const state = getIntegrationsState();
    expect(state.denchCloud).toEqual({
      hasKey: true,
      isPrimaryProvider: false,
      primaryModel: "anthropic/claude-4",
    });
    const exa = state.integrations.find((integration) => integration.id === "exa");
    expect(exa).toMatchObject({
      locked: true,
      lockReason: "dench_not_primary",
      lockBadge: "Use ReBattery Cloud",
      enabled: false,
    });
  });

  it("rejects enabling Exa when ReBattery Cloud is locked", async () => {
    const { existsSync, readFileSync } = await import("node:fs");
    const mockExists = vi.mocked(existsSync);
    const mockRead = vi.mocked(readFileSync);

    mockExists.mockImplementation((path) => String(path).endsWith("openclaw.json"));
    mockRead.mockImplementation((path) => {
      if (String(path).endsWith("openclaw.json")) {
        return JSON.stringify({
          agents: {
            defaults: {
              model: {
                primary: "anthropic/claude-4",
              },
            },
          },
          models: {
            providers: {
              "dench-cloud": {
                apiKey: "dench-key",
              },
            },
          },
        }) as never;
      }
      return "" as never;
    });

    const { setExaIntegrationEnabled } = await import("./integrations.js");
    const result = setExaIntegrationEnabled(true);
    expect(result.changed).toBe(false);
    expect(result.error).toBe("This integration requires ReBattery Cloud to be the primary provider.");
  });

  it("enables Exa and suppresses built-in web search", async () => {
    const { existsSync, readFileSync, writeFileSync } = await import("node:fs");
    const mockExists = vi.mocked(existsSync);
    const mockRead = vi.mocked(readFileSync);
    const mockWrite = vi.mocked(writeFileSync);
    let openClawJson = JSON.stringify({
      agents: {
        defaults: {
          model: {
            primary: "dench-cloud/claude-sonnet-4.6",
          },
        },
      },
      models: {
        providers: {
          "dench-cloud": {
            apiKey: "dench-key",
          },
        },
      },
      plugins: {
        entries: {},
      },
    });
    let metadataJson = "";

    mockExists.mockImplementation((path) => {
      const value = String(path);
      return (
        value.endsWith("openclaw.json") ||
        (value.endsWith(".dench-integrations.json") && metadataJson.length > 0) ||
        value === "/home/testuser/.openclaw-dench/extensions/exa-search"
      );
    });
    mockRead.mockImplementation((path) => {
      if (String(path).endsWith("openclaw.json")) {
        return openClawJson as never;
      }
      if (String(path).endsWith(".dench-integrations.json")) {
        return metadataJson as never;
      }
      return "" as never;
    });
    mockWrite.mockImplementation((path, data) => {
      if (String(path).endsWith("openclaw.json")) {
        openClawJson = String(data);
      }
      if (String(path).endsWith(".dench-integrations.json")) {
        metadataJson = String(data);
      }
    });

    const { setExaIntegrationEnabled } = await import("./integrations.js");
    const result = setExaIntegrationEnabled(true);

    expect(result.changed).toBe(true);
    expect(result.state.search.builtIn).toEqual({
      enabled: false,
      denied: true,
      provider: null,
    });
    expect(result.state.metadata.exa).toEqual({
      ownsSearch: true,
      fallbackProvider: "duckduckgo",
    });
    expect(mockWrite).toHaveBeenCalledTimes(2);
    const writtenConfig = JSON.parse(openClawJson);
    expect(writtenConfig.plugins.allow).toEqual(["exa-search"]);
    expect(writtenConfig.plugins.entries["exa-search"]).toEqual({ enabled: true });
    expect(writtenConfig.plugins.load.paths).toEqual([
      "/home/testuser/.openclaw-dench/extensions/exa-search",
    ]);
    expect(writtenConfig.plugins.installs["exa-search"]).toEqual({
      source: "path",
      installPath: "/home/testuser/.openclaw-dench/extensions/exa-search",
      sourcePath: expect.any(String),
      installedAt: expect.any(String),
    });
    expect(writtenConfig.tools.deny).toEqual(["web_search"]);
    expect(writtenConfig.tools.web.search).toEqual({ enabled: false });
  });

  it("disables Exa and restores duckduckgo fallback", async () => {
    const { existsSync, readFileSync, writeFileSync } = await import("node:fs");
    const mockExists = vi.mocked(existsSync);
    const mockRead = vi.mocked(readFileSync);
    const mockWrite = vi.mocked(writeFileSync);
    let openClawJson = JSON.stringify({
      agents: {
        defaults: {
          model: {
            primary: "dench-cloud/claude-sonnet-4.6",
          },
        },
      },
      models: {
        providers: {
          "dench-cloud": {
            apiKey: "dench-key",
          },
        },
      },
      plugins: {
        allow: ["exa-search"],
        entries: {
          "exa-search": {
            enabled: true,
          },
        },
      },
      tools: {
        deny: ["web_search"],
        web: {
          search: {
            enabled: false,
            provider: "brave",
          },
        },
      },
    });
    let metadataJson = JSON.stringify({
      schemaVersion: 1,
      exa: {
        ownsSearch: true,
        fallbackProvider: "duckduckgo",
      },
    });

    mockExists.mockImplementation((path) => {
      const value = String(path);
      return value.endsWith("openclaw.json") || value.endsWith(".dench-integrations.json");
    });
    mockRead.mockImplementation((path) => {
      const value = String(path);
      if (value.endsWith("openclaw.json")) {
        return openClawJson as never;
      }
      if (value.endsWith(".dench-integrations.json")) {
        return metadataJson as never;
      }
      return "" as never;
    });
    mockWrite.mockImplementation((path, data) => {
      if (String(path).endsWith("openclaw.json")) {
        openClawJson = String(data);
      }
      if (String(path).endsWith(".dench-integrations.json")) {
        metadataJson = String(data);
      }
    });

    const { setExaIntegrationEnabled } = await import("./integrations.js");
    const result = setExaIntegrationEnabled(false);

    expect(result.changed).toBe(true);
    expect(result.state.search.effectiveOwner).toBe("web_search");
    expect(result.state.search.builtIn).toMatchObject({
      enabled: true,
      denied: false,
    });

    const writtenConfig = JSON.parse(openClawJson);
    expect(writtenConfig.plugins.entries["exa-search"]).toEqual({ enabled: false });
    expect(writtenConfig.tools.deny).toEqual([]);
    expect(writtenConfig.tools.web.search.enabled).toBe(true);
  });

  it("hard-enables Apollo when the plugin asset is present", async () => {
    const { existsSync, readFileSync, writeFileSync } = await import("node:fs");
    const mockExists = vi.mocked(existsSync);
    const mockRead = vi.mocked(readFileSync);
    const mockWrite = vi.mocked(writeFileSync);
    let openClawJson = JSON.stringify({
      agents: {
        defaults: {
          model: {
            primary: "dench-cloud/claude-sonnet-4.6",
          },
        },
      },
      models: {
        providers: {
          "dench-cloud": {
            apiKey: "dench-key",
          },
        },
      },
      plugins: {
        entries: {
          "apollo-enrichment": {
            enabled: false,
            config: {
              apiKey: "stale-local-key",
              mode: "max",
            },
          },
        },
      },
    });

    mockExists.mockImplementation((path) => {
      const value = String(path);
      return value.endsWith("openclaw.json") || value === "/home/testuser/.openclaw-dench/extensions/apollo-enrichment";
    });
    mockRead.mockImplementation((path) => {
      if (String(path).endsWith("openclaw.json")) {
        return openClawJson as never;
      }
      return "" as never;
    });
    mockWrite.mockImplementation((path, data) => {
      if (String(path).endsWith("openclaw.json")) {
        openClawJson = String(data);
      }
    });

    const { setApolloIntegrationEnabled } = await import("./integrations.js");
    const result = setApolloIntegrationEnabled(true);

    expect(result.changed).toBe(true);
    const writtenConfig = JSON.parse(openClawJson);
    expect(writtenConfig.plugins.allow).toEqual(["apollo-enrichment"]);
    expect(writtenConfig.plugins.entries["apollo-enrichment"]).toEqual({
      enabled: true,
      config: {
        mode: "max",
      },
    });
    expect(writtenConfig.plugins.load.paths).toEqual([
      "/home/testuser/.openclaw-dench/extensions/apollo-enrichment",
    ]);
    expect(writtenConfig.plugins.installs["apollo-enrichment"]).toEqual({
      source: "path",
      installPath: "/home/testuser/.openclaw-dench/extensions/apollo-enrichment",
      sourcePath: expect.any(String),
      installedAt: expect.any(String),
    });
  });

  it("removes and restores the Dench ElevenLabs override", async () => {
    const { existsSync, readFileSync, writeFileSync } = await import("node:fs");
    const mockExists = vi.mocked(existsSync);
    const mockRead = vi.mocked(readFileSync);
    const mockWrite = vi.mocked(writeFileSync);
    let openClawJson = JSON.stringify({
      agents: {
        defaults: {
          model: {
            primary: "dench-cloud/claude-sonnet-4.6",
          },
        },
      },
      models: {
        providers: {
          "dench-cloud": {
            apiKey: "dench-key",
          },
        },
      },
      messages: {
        tts: {
          provider: "elevenlabs",
          providers: {
            elevenlabs: {
              baseUrl: "https://gateway.merseoriginals.com",
              apiKey: "dench-key",
              voiceId: "voice_123",
            },
          },
        },
      },
      plugins: {
        entries: {
          "dench-ai-gateway": {
            enabled: true,
            config: {
              gatewayUrl: "https://gateway.merseoriginals.com",
            },
          },
        },
      },
    });

    mockExists.mockImplementation((path) => String(path).endsWith("openclaw.json"));
    mockRead.mockImplementation((path) => {
      if (String(path).endsWith("openclaw.json")) {
        return openClawJson as never;
      }
      return "" as never;
    });
    mockWrite.mockImplementation((path, data) => {
      if (String(path).endsWith("openclaw.json")) {
        openClawJson = String(data);
      }
    });

    const { setElevenLabsIntegrationEnabled } = await import("./integrations.js");
    const disabled = setElevenLabsIntegrationEnabled(false);
    expect(disabled.changed).toBe(true);
    let writtenConfig = JSON.parse(openClawJson);
    expect(writtenConfig.messages.tts.providers.elevenlabs).toEqual({
      voiceId: "voice_123",
    });
    expect(writtenConfig.messages.tts.provider).toBeUndefined();
    expect(writtenConfig.messages.tts.elevenlabs).toBeUndefined();

    const enabled = setElevenLabsIntegrationEnabled(true);
    expect(enabled.changed).toBe(true);
    writtenConfig = JSON.parse(openClawJson);
    expect(writtenConfig.messages.tts.provider).toBe("elevenlabs");
    expect(writtenConfig.messages.tts.providers.elevenlabs).toEqual({
      voiceId: "voice_123",
      baseUrl: "https://gateway.merseoriginals.com",
      apiKey: "dench-key",
    });
    expect(writtenConfig.messages.tts.elevenlabs).toBeUndefined();
  });

  it("restarts the OpenClaw gateway for the active profile", async () => {
    const { execFile } = await import("node:child_process");
    const mockExecFile = vi.mocked(execFile);
    mockExecFile.mockImplementationOnce(((
      _file: string,
      _args: readonly string[] | null | undefined,
      _options: ExecFileOptions | null | undefined,
      callback:
        | ((
            error: ExecFileException | null,
            stdout: string | Buffer,
            stderr: string | Buffer,
          ) => void)
        | undefined,
    ) => {
      callback?.(null, "", "");
      return undefined as never;
    }) as unknown as typeof execFile);

    const { refreshIntegrationsRuntime } = await import("./integrations.js");
    const result = await refreshIntegrationsRuntime();

    expect(result).toEqual({
      attempted: true,
      restarted: true,
      error: null,
      profile: "dench",
    });
    expect(mockExecFile).toHaveBeenCalledWith(
      "openclaw",
      ["--profile", "dench", "gateway", "restart"],
      expect.objectContaining({ timeout: 30000 }),
      expect.any(Function),
    );
  });

  it("preserves unrelated config keys through write round-trip", async () => {
    const { existsSync, readFileSync, writeFileSync } = await import("node:fs");
    const mockExists = vi.mocked(existsSync);
    const mockRead = vi.mocked(readFileSync);
    const mockWrite = vi.mocked(writeFileSync);
    const originalConfig = {
      meta: { lastTouchedVersion: "2026.3.28" },
      wizard: { lastRunAt: "2026-03-30" },
      auth: { profiles: { "dench-cloud:default": { provider: "dench-cloud" } } },
      agents: { defaults: { model: { primary: "dench-cloud/claude-sonnet-4.6" } } },
      gateway: { port: 19002 },
      models: { providers: { "dench-cloud": { apiKey: "dench-key" } } },
      plugins: { entries: { "apollo-enrichment": { enabled: true } } },
    };
    let openClawJson = JSON.stringify(originalConfig);

    mockExists.mockImplementation((path) => {
      const value = String(path);
      return (
        value.endsWith("openclaw.json") ||
        value === "/home/testuser/.openclaw-dench/extensions/apollo-enrichment"
      );
    });
    mockRead.mockImplementation((path) => {
      if (String(path).endsWith("openclaw.json")) {
        return openClawJson as never;
      }
      return "" as never;
    });
    mockWrite.mockImplementation((path, data) => {
      if (String(path).endsWith("openclaw.json")) {
        openClawJson = String(data);
      }
    });

    const { setApolloIntegrationEnabled } = await import("./integrations.js");
    setApolloIntegrationEnabled(false);

    const writtenConfig = JSON.parse(openClawJson);
    expect(writtenConfig.meta).toEqual(originalConfig.meta);
    expect(writtenConfig.wizard).toEqual(originalConfig.wizard);
    expect(writtenConfig.auth).toEqual(originalConfig.auth);
    expect(writtenConfig.agents).toEqual(originalConfig.agents);
    expect(writtenConfig.gateway).toEqual(originalConfig.gateway);
    expect(writtenConfig.plugins.entries["apollo-enrichment"]).toEqual({ enabled: false });
  });

  it("reports ElevenLabs as disabled when apiKey is missing from config", async () => {
    const { existsSync, readFileSync } = await import("node:fs");
    const mockExists = vi.mocked(existsSync);
    const mockRead = vi.mocked(readFileSync);

    mockExists.mockImplementation((path) => String(path).endsWith("openclaw.json"));
    mockRead.mockImplementation((path) => {
      if (String(path).endsWith("openclaw.json")) {
        return JSON.stringify({
          agents: {
            defaults: {
              model: { primary: "dench-cloud/claude-sonnet-4.6" },
            },
          },
          models: {
            providers: {
              "dench-cloud": { apiKey: "dench-key" },
            },
          },
          plugins: {
            entries: {
              "dench-ai-gateway": {
                enabled: true,
                config: { gatewayUrl: "https://gateway.merseoriginals.com" },
              },
            },
          },
          messages: {
            tts: {
              provider: "elevenlabs",
              providers: {
                elevenlabs: {
                  baseUrl: "https://gateway.merseoriginals.com",
                },
              },
            },
          },
        }) as never;
      }
      return "" as never;
    });

    const { getIntegrationsState } = await import("./integrations.js");
    const state = getIntegrationsState();
    const elevenlabs = state.integrations.find((i) => i.id === "elevenlabs");
    expect(elevenlabs?.enabled).toBe(false);
    expect(elevenlabs?.overrideActive).toBe(false);
    expect(elevenlabs?.healthIssues).toContain("missing_api_key");
    expect(elevenlabs?.healthIssues).toContain("missing_override");
  });

  it("reports ElevenLabs as enabled when all runtime fields are present", async () => {
    const { existsSync, readFileSync } = await import("node:fs");
    const mockExists = vi.mocked(existsSync);
    const mockRead = vi.mocked(readFileSync);

    mockExists.mockImplementation((path) => String(path).endsWith("openclaw.json"));
    mockRead.mockImplementation((path) => {
      if (String(path).endsWith("openclaw.json")) {
        return JSON.stringify({
          agents: {
            defaults: {
              model: { primary: "dench-cloud/claude-sonnet-4.6" },
            },
          },
          models: {
            providers: {
              "dench-cloud": { apiKey: "dench-key" },
            },
          },
          plugins: {
            entries: {
              "dench-ai-gateway": {
                enabled: true,
                config: { gatewayUrl: "https://gateway.merseoriginals.com" },
              },
            },
          },
          messages: {
            tts: {
              provider: "elevenlabs",
              providers: {
                elevenlabs: {
                  baseUrl: "https://gateway.merseoriginals.com",
                  apiKey: "dench-key",
                },
              },
            },
          },
        }) as never;
      }
      return "" as never;
    });

    const { getIntegrationsState } = await import("./integrations.js");
    const state = getIntegrationsState();
    const elevenlabs = state.integrations.find((i) => i.id === "elevenlabs");
    expect(elevenlabs?.enabled).toBe(true);
    expect(elevenlabs?.overrideActive).toBe(true);
    expect(elevenlabs?.healthIssues).not.toContain("missing_api_key");
    expect(elevenlabs?.healthIssues).not.toContain("missing_override");
  });

  it("repairs older profiles by copying and re-registering bundled plugins", async () => {
    const { cpSync, existsSync, readFileSync, writeFileSync } = await import("node:fs");
    const mockCopy = vi.mocked(cpSync);
    const mockExists = vi.mocked(existsSync);
    const mockRead = vi.mocked(readFileSync);
    const mockWrite = vi.mocked(writeFileSync);
    const bundledGatewaySource = resolveBundledExtensionSourcePath("dench-ai-gateway");
    const bundledIdentitySource = resolveBundledExtensionSourcePath("dench-identity");
    const bundledExaSource = resolveBundledExtensionSourcePath("exa-search");
    const bundledApolloSource = resolveBundledExtensionSourcePath("apollo-enrichment");
    const bundledSharedSource = resolveBundledExtensionSourcePath("shared");
    const existingPaths = new Set<string>([
      "/home/testuser/.openclaw-dench/openclaw.json",
      bundledGatewaySource,
      bundledIdentitySource,
      bundledExaSource,
      bundledApolloSource,
      bundledSharedSource,
    ]);
    let openClawJson = JSON.stringify({
      plugins: {
        entries: {},
      },
    });

    mockExists.mockImplementation((path) => existingPaths.has(String(path)));
    mockRead.mockImplementation((path) => {
      if (String(path).endsWith("openclaw.json")) {
        return openClawJson as never;
      }
      return "" as never;
    });
    mockCopy.mockImplementation((source, destination) => {
      existingPaths.add(String(destination));
      existingPaths.add(String(source));
    });
    mockWrite.mockImplementation((path, data) => {
      if (String(path).endsWith("openclaw.json")) {
        openClawJson = String(data);
      }
    });

    const { repairManagedPluginsProfile } = await import("./integrations.js");
    const result = repairManagedPluginsProfile();

    expect(result.changed).toBe(true);
    expect(result.repairedIds).toEqual(["dench-ai-gateway", "dench-identity", "apollo", "exa"]);
    expect(result.repairs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "dench-ai-gateway",
          assetAvailable: true,
          assetCopied: true,
          repaired: true,
        }),
        expect.objectContaining({
          id: "dench-identity",
          assetAvailable: true,
          assetCopied: true,
          repaired: true,
        }),
        expect.objectContaining({
          id: "exa",
          assetAvailable: true,
          assetCopied: true,
          repaired: true,
        }),
        expect.objectContaining({
          id: "apollo",
          assetAvailable: true,
          assetCopied: true,
          repaired: true,
        }),
      ]),
    );
    expect(mockCopy).toHaveBeenCalledTimes(5);
    expect(mockCopy).toHaveBeenCalledWith(
      bundledSharedSource,
      "/home/testuser/.openclaw-dench/extensions/shared",
      { recursive: true, force: true },
    );

    const writtenConfig = JSON.parse(openClawJson);
    expect(writtenConfig.plugins.allow).toEqual([
      "dench-ai-gateway",
      "dench-identity",
      "apollo-enrichment",
      "exa-search",
    ]);
    expect(writtenConfig.plugins.load.paths).toEqual([
      "/home/testuser/.openclaw-dench/extensions/dench-ai-gateway",
      "/home/testuser/.openclaw-dench/extensions/dench-identity",
      "/home/testuser/.openclaw-dench/extensions/apollo-enrichment",
      "/home/testuser/.openclaw-dench/extensions/exa-search",
    ]);
    expect(writtenConfig.plugins.entries["dench-ai-gateway"]).toEqual({
      enabled: true,
      config: {
        gatewayUrl: "https://gateway.merseoriginals.com",
      },
    });
    expect(writtenConfig.plugins.entries["dench-identity"]).toEqual({ enabled: true });
    expect(writtenConfig.plugins.entries["apollo-enrichment"]).toEqual({ enabled: true });
    expect(writtenConfig.plugins.entries["exa-search"]).toEqual({ enabled: true });
    expect(writtenConfig.plugins.installs["dench-ai-gateway"]).toEqual({
      source: "path",
      installPath: "/home/testuser/.openclaw-dench/extensions/dench-ai-gateway",
      sourcePath: bundledGatewaySource,
      installedAt: expect.any(String),
    });
    expect(writtenConfig.plugins.installs["dench-identity"]).toEqual({
      source: "path",
      installPath: "/home/testuser/.openclaw-dench/extensions/dench-identity",
      sourcePath: bundledIdentitySource,
      installedAt: expect.any(String),
    });
    expect(writtenConfig.plugins.installs["exa-search"]).toEqual({
      source: "path",
      installPath: "/home/testuser/.openclaw-dench/extensions/exa-search",
      sourcePath: bundledExaSource,
      installedAt: expect.any(String),
    });
    expect(writtenConfig.plugins.installs["apollo-enrichment"]).toEqual({
      source: "path",
      installPath: "/home/testuser/.openclaw-dench/extensions/apollo-enrichment",
      sourcePath: bundledApolloSource,
      installedAt: expect.any(String),
    });
  });

  it("does not rewrite an already repaired managed plugin profile", async () => {
    const { cpSync, existsSync, readFileSync, writeFileSync } = await import("node:fs");
    const mockCopy = vi.mocked(cpSync);
    const mockExists = vi.mocked(existsSync);
    const mockRead = vi.mocked(readFileSync);
    const mockWrite = vi.mocked(writeFileSync);
    const openClawJson = JSON.stringify({
      plugins: {
        allow: ["dench-ai-gateway", "dench-identity", "apollo-enrichment", "exa-search"],
        load: {
          paths: [
            "/home/testuser/.openclaw-dench/extensions/dench-ai-gateway",
            "/home/testuser/.openclaw-dench/extensions/dench-identity",
            "/home/testuser/.openclaw-dench/extensions/apollo-enrichment",
            "/home/testuser/.openclaw-dench/extensions/exa-search",
          ],
        },
        entries: {
          "dench-ai-gateway": {
            enabled: true,
            config: {
              gatewayUrl: "https://gateway.merseoriginals.com",
            },
          },
          "dench-identity": { enabled: true },
          "apollo-enrichment": { enabled: true },
          "exa-search": { enabled: true },
        },
        installs: {
          "dench-ai-gateway": {
            source: "path",
            sourcePath: resolveBundledExtensionSourcePath("dench-ai-gateway"),
            installPath: "/home/testuser/.openclaw-dench/extensions/dench-ai-gateway",
            installedAt: "2026-01-01T00:00:00.000Z",
          },
          "dench-identity": {
            source: "path",
            sourcePath: resolveBundledExtensionSourcePath("dench-identity"),
            installPath: "/home/testuser/.openclaw-dench/extensions/dench-identity",
            installedAt: "2026-01-01T00:00:00.000Z",
          },
          "apollo-enrichment": {
            source: "path",
            sourcePath: resolveBundledExtensionSourcePath("apollo-enrichment"),
            installPath: "/home/testuser/.openclaw-dench/extensions/apollo-enrichment",
            installedAt: "2026-01-01T00:00:00.000Z",
          },
          "exa-search": {
            source: "path",
            sourcePath: resolveBundledExtensionSourcePath("exa-search"),
            installPath: "/home/testuser/.openclaw-dench/extensions/exa-search",
            installedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      },
    });
    const existingPaths = new Set([
      "/home/testuser/.openclaw-dench/openclaw.json",
      resolveBundledExtensionSourcePath("dench-ai-gateway"),
      resolveBundledExtensionSourcePath("dench-identity"),
      resolveBundledExtensionSourcePath("apollo-enrichment"),
      resolveBundledExtensionSourcePath("exa-search"),
      "/home/testuser/.openclaw-dench/extensions/dench-ai-gateway",
      "/home/testuser/.openclaw-dench/extensions/dench-identity",
      "/home/testuser/.openclaw-dench/extensions/apollo-enrichment",
      "/home/testuser/.openclaw-dench/extensions/exa-search",
      resolveBundledExtensionSourcePath("shared"),
      "/home/testuser/.openclaw-dench/extensions/shared",
    ]);

    mockExists.mockImplementation((path) => existingPaths.has(String(path)));
    mockRead.mockImplementation((path) => {
      if (String(path).endsWith("openclaw.json")) {
        return openClawJson as never;
      }
      return "" as never;
    });
    mockCopy.mockClear();
    mockWrite.mockClear();

    const { repairManagedPluginsProfile } = await import("./integrations.js");
    const result = repairManagedPluginsProfile();

    expect(result.changed).toBe(false);
    expect(result.repairedIds).toEqual([]);
    expect(mockCopy).not.toHaveBeenCalled();
    expect(mockWrite).not.toHaveBeenCalled();
  });
});
