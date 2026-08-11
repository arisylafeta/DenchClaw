import { describe, expect, it, vi } from "vitest";
import register from "./index.js";

function createApi() {
  const providers: any[] = [];
  const tools: any[] = [];
  const services: any[] = [];
  const api: any = {
    config: {
      plugins: {
        entries: {
          "dench-ai-gateway": {
            config: {
              enabled: true,
              gatewayUrl: "https://gateway.example.com",
            },
          },
        },
      },
    },
    registerProvider(provider: any) {
      providers.push(provider);
    },
    registerTool(tool: any) {
      tools.push(tool);
    },
    registerService(service: any) {
      services.push(service);
    },
    logger: { info: vi.fn() },
  };
  return { api, providers, tools, services };
}

describe("dench-ai-gateway", () => {
  it("registers the model provider without custom integration adapter tools", () => {
    const { api, providers, tools, services } = createApi();

    register(api);

    expect(providers.map((provider) => provider.id)).toContain("dench-cloud");
    expect(services.map((service) => service.id)).toContain("dench-ai-gateway");
    expect(tools).toEqual([]);
    expect(api.config.mcp?.servers).toBeUndefined();
  });

  it("does nothing when disabled", () => {
    const { api, providers, tools, services } = createApi();
    api.config.plugins.entries["dench-ai-gateway"].config.enabled = false;

    register(api);

    expect(providers).toEqual([]);
    expect(tools).toEqual([]);
    expect(services).toEqual([]);
  });
});
