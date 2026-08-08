// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CloudSettingsPanel } from "./cloud-settings-panel";
import type { DenchIntegrationState, IntegrationsState } from "@/lib/integrations";

vi.mock("../integrations/dench-integrations-section", () => ({
  DenchIntegrationsSection: ({
    data,
    onToggle,
    excludeIntegrationIds,
  }: {
    data?: IntegrationsState | null;
    onToggle?: (integration: DenchIntegrationState, enabled: boolean) => void;
    excludeIntegrationIds?: readonly string[];
  }) => {
    const excluded = new Set(excludeIntegrationIds ?? []);
    const visible = data?.integrations.filter((i) => !excluded.has(i.id)) ?? [];
    return (
      <div>
        <div>Mock Integrations</div>
        {visible.map((integration) => (
          <button
            key={integration.id}
            type="button"
            onClick={() => onToggle?.(integration, !integration.enabled)}
          >
            {integration.label}:{integration.enabled ? "on" : "off"}:{integration.locked ? "locked" : "open"}
          </button>
        ))}
      </div>
    );
  },
}));

const baseState = {
  status: "valid" as const,
  apiKeySource: "config" as const,
  gatewayUrl: "https://gateway.merseoriginals.com",
  primaryModel: null,
  isDenchPrimary: false,
  selectedDenchModel: null,
  selectedVoiceId: null,
  elevenLabsEnabled: true,
  models: [
    {
      id: "claude-opus-4.6",
      stableId: "anthropic.claude-opus-4-6-v1",
      displayName: "Claude Opus 4.6",
      provider: "anthropic",
      reasoning: true,
    },
    {
      id: "gpt-5.4",
      stableId: "gpt-5.4",
      displayName: "GPT-5.4",
      provider: "openai",
      reasoning: true,
    },
  ],
  recommendedModelId: "claude-opus-4.6",
};

const voicesPayload = {
  voices: [
    {
      voiceId: "voice_123",
      name: "Rachel",
      description: "Warm narration voice",
      category: "premade",
      previewUrl: null,
      labels: [],
    },
  ],
};

const integrationsState: IntegrationsState = {
  denchCloud: {
    hasKey: true,
    isPrimaryProvider: false,
    primaryModel: null,
  },
  metadata: {
    schemaVersion: 1,
    exa: { ownsSearch: false, fallbackProvider: "duckduckgo" },
    apollo: {},
    elevenlabs: {},
  },
  search: {
    builtIn: { enabled: true, denied: false, provider: null },
    effectiveOwner: "web_search",
  },
  managedPlugins: [],
  integrations: [
    {
      id: "exa",
      label: "Exa",
      enabled: false,
      available: false,
      locked: true,
      lockReason: "dench_not_primary",
      lockBadge: "Use ReBattery Cloud",
      gatewayBaseUrl: "https://gateway.merseoriginals.com",
      auth: { configured: true, source: "config" },
      plugin: null,
      managedByDench: true,
      healthIssues: [],
      health: {
        status: "disabled",
        pluginMissing: false,
        pluginInstalledButDisabled: false,
        configMismatch: false,
        missingAuth: false,
        missingGatewayOverride: false,
      },
    },
    {
      id: "apollo",
      label: "Apollo",
      enabled: false,
      available: false,
      locked: true,
      lockReason: "dench_not_primary",
      lockBadge: "Use ReBattery Cloud",
      gatewayBaseUrl: "https://gateway.merseoriginals.com",
      auth: { configured: true, source: "config" },
      plugin: null,
      managedByDench: true,
      healthIssues: [],
      health: {
        status: "disabled",
        pluginMissing: false,
        pluginInstalledButDisabled: false,
        configMismatch: false,
        missingAuth: false,
        missingGatewayOverride: false,
      },
    },
    {
      id: "elevenlabs",
      label: "ElevenLabs",
      enabled: false,
      available: false,
      locked: true,
      lockReason: "dench_not_primary",
      lockBadge: "Use ReBattery Cloud",
      gatewayBaseUrl: "https://gateway.merseoriginals.com",
      auth: { configured: true, source: "config" },
      plugin: null,
      managedByDench: true,
      healthIssues: [],
      health: {
        status: "disabled",
        pluginMissing: false,
        pluginInstalledButDisabled: false,
        configMismatch: false,
        missingAuth: false,
        missingGatewayOverride: false,
      },
    },
  ],
};

describe("CloudSettingsPanel", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the rich picker placeholder when ReBattery Cloud is not primary", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/settings/cloud") {
        return new Response(JSON.stringify(baseState));
      }
      if (url === "/api/integrations") {
        return new Response(JSON.stringify(integrationsState));
      }
      if (url === "/api/voice/voices") {
        return new Response(JSON.stringify(voicesPayload));
      }
      if (url === "/api/settings/mcp") {
        return new Response(JSON.stringify({ servers: [] }));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    render(<CloudSettingsPanel />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Select primary model" })).toBeInTheDocument();
    });

    expect(screen.getByText("Choose a model...")).toBeInTheDocument();
    expect(screen.getByText("Mock Integrations")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("stages model, voice, and integration changes until Save is clicked", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/settings/cloud" && (!init || init.method === undefined)) {
        return new Response(JSON.stringify(baseState));
      }
      if (url === "/api/integrations") {
        return new Response(JSON.stringify(integrationsState));
      }
      if (url === "/api/voice/voices") {
        return new Response(JSON.stringify(voicesPayload));
      }
      if (url === "/api/settings/mcp") {
        return new Response(JSON.stringify({ servers: [] }));
      }

      if (url === "/api/settings/cloud" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as {
          action: string;
          stableId: string;
          voiceId: string;
          integrations: Record<string, boolean>;
        };
        expect(body).toEqual({
          action: "save_active_settings",
          stableId: "anthropic.claude-opus-4-6-v1",
          voiceId: "voice_123",
          integrations: {
            exa: true,
            apollo: false,
            elevenlabs: false,
          },
        });
        return new Response(JSON.stringify({
          state: {
            ...baseState,
            isDenchPrimary: true,
            selectedDenchModel: "anthropic.claude-opus-4-6-v1",
            selectedVoiceId: "voice_123",
          },
          integrationsState: {
            ...integrationsState,
            denchCloud: {
              ...integrationsState.denchCloud,
              isPrimaryProvider: true,
              primaryModel: "dench-cloud/anthropic.claude-opus-4-6-v1",
            },
            integrations: integrationsState.integrations.map((integration) =>
              integration.id === "exa"
                ? { ...integration, enabled: true, locked: false, lockReason: null, lockBadge: null, available: true }
                : { ...integration, locked: false, lockReason: null, lockBadge: null, available: true },
            ),
          },
          changed: true,
          refresh: {
            attempted: true,
            restarted: true,
            error: null,
            profile: "dench",
          },
        }));
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });
    global.fetch = fetchMock as typeof fetch;

    render(<CloudSettingsPanel />);

    await user.click(await screen.findByRole("button", { name: "Select primary model" }));
    await user.click(await screen.findByText("Claude Opus 4.6"));
    expect(fetchMock).toHaveBeenCalledTimes(4);

    const voiceTrigger = await screen.findByRole("button", {
      name: "Select ElevenLabs voice",
    });
    await waitFor(() => {
      expect(voiceTrigger).not.toBeDisabled();
    });
    await user.click(voiceTrigger);
    await user.click(await screen.findByRole("menuitemradio", { name: /Rachel/ }));
    await user.click(screen.getByRole("button", { name: "Exa:off:open" }));

    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(fetchMock).toHaveBeenCalledTimes(4);

    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(5);
    });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("shows the full provider logo lineup on the enrichment waterfall card", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/settings/cloud") {
        return new Response(JSON.stringify(baseState));
      }
      if (url === "/api/integrations") {
        return new Response(JSON.stringify(integrationsState));
      }
      if (url === "/api/voice/voices") {
        return new Response(JSON.stringify(voicesPayload));
      }
      if (url === "/api/settings/mcp") {
        return new Response(JSON.stringify({ servers: [] }));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    render(<CloudSettingsPanel />);

    await waitFor(() => {
      expect(screen.getByText("ReBattery Enrichment")).toBeInTheDocument();
    });
    expect(screen.getByText("Enrich people and company data with multiple providers.")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Toggle ReBattery Enrichments" })).toBeInTheDocument();

    expect(screen.getByTitle("ReBattery")).toBeInTheDocument();
    expect(screen.getByTitle("Aviato")).toBeInTheDocument();
    expect(screen.getByTitle("Apollo")).toBeInTheDocument();
    expect(screen.getByTitle("People Data Labs")).toBeInTheDocument();
    expect(screen.getByTitle("Datagma")).toBeInTheDocument();
    expect(screen.getByTitle("RocketReach")).toBeInTheDocument();
    expect(screen.getByTitle("Hunter")).toBeInTheDocument();
    expect(screen.getByTitle("Better Contacts")).toBeInTheDocument();
    expect(screen.getByTitle("Dropcontact")).toBeInTheDocument();
    expect(screen.getByTitle("Explorium")).toBeInTheDocument();
  });
});
