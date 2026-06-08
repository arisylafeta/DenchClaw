import { afterEach, describe, expect, it } from "vitest";
import {
  resolveAgentBackend,
  resolveHermesConfig,
  type AgentBackend,
  type HermesConfig,
} from "./agent-backend";

function cleanEnv() {
  delete process.env.DENCH_AGENT_BACKEND;
  delete process.env.HERMES_API_BASE_URL;
  delete process.env.HERMES_API_KEY;
  delete process.env.HERMES_MODEL;
}

afterEach(() => {
  cleanEnv();
});

describe("resolveAgentBackend", () => {
  it('returns "hermes" when DENCH_AGENT_BACKEND is exactly "hermes"', () => {
    process.env.DENCH_AGENT_BACKEND = "hermes";
    expect(resolveAgentBackend()).toBe("hermes");
  });

  it('returns "openclaw" when DENCH_AGENT_BACKEND is not set', () => {
    expect(resolveAgentBackend()).toBe("openclaw");
  });

  it('returns "openclaw" when DENCH_AGENT_BACKEND is empty string', () => {
    process.env.DENCH_AGENT_BACKEND = "";
    expect(resolveAgentBackend()).toBe("openclaw");
  });

  it('returns "openclaw" when DENCH_AGENT_BACKEND has wrong casing', () => {
    process.env.DENCH_AGENT_BACKEND = "Hermes";
    expect(resolveAgentBackend()).toBe("openclaw");
  });

  it('returns "openclaw" when DENCH_AGENT_BACKEND is "HERMES"', () => {
    process.env.DENCH_AGENT_BACKEND = "HERMES";
    expect(resolveAgentBackend()).toBe("openclaw");
  });

  it('returns "openclaw" when DENCH_AGENT_BACKEND is unrelated value', () => {
    process.env.DENCH_AGENT_BACKEND = "something-else";
    expect(resolveAgentBackend()).toBe("openclaw");
  });

  it('returns "openclaw" when DENCH_AGENT_BACKEND has whitespace around "hermes"', () => {
    process.env.DENCH_AGENT_BACKEND = " hermes ";
    expect(resolveAgentBackend()).toBe("openclaw");
  });
});

describe("resolveHermesConfig", () => {
  it("returns defaults when no env vars are set", () => {
    const config = resolveHermesConfig();
    expect(config).toEqual({
      baseUrl: "http://127.0.0.1:8642",
      apiKey: "",
      model: "hermes-agent",
    });
  });

  it("reads HERMES_API_BASE_URL from env", () => {
    process.env.HERMES_API_BASE_URL = "http://custom-host:9000";
    const config = resolveHermesConfig();
    expect(config.baseUrl).toBe("http://custom-host:9000");
  });

  it("strips trailing slash from HERMES_API_BASE_URL", () => {
    process.env.HERMES_API_BASE_URL = "http://custom-host:9000/";
    const config = resolveHermesConfig();
    expect(config.baseUrl).toBe("http://custom-host:9000");
  });

  it("strips multiple trailing slashes from HERMES_API_BASE_URL", () => {
    process.env.HERMES_API_BASE_URL = "http://custom-host:9000///";
    const config = resolveHermesConfig();
    expect(config.baseUrl).toBe("http://custom-host:9000");
  });

  it("reads HERMES_API_KEY from env", () => {
    process.env.HERMES_API_KEY = "sk-test-key-123";
    const config = resolveHermesConfig();
    expect(config.apiKey).toBe("sk-test-key-123");
  });

  it("defaults apiKey to empty string when not set", () => {
    const config = resolveHermesConfig();
    expect(config.apiKey).toBe("");
  });

  it("reads HERMES_MODEL from env", () => {
    process.env.HERMES_MODEL = "custom-model";
    const config = resolveHermesConfig();
    expect(config.model).toBe("custom-model");
  });

  it("defaults model to hermes-agent when not set", () => {
    const config = resolveHermesConfig();
    expect(config.model).toBe("hermes-agent");
  });

  it("reads all env vars together", () => {
    process.env.HERMES_API_BASE_URL = "https://remote:443/";
    process.env.HERMES_API_KEY = "sk-full";
    process.env.HERMES_MODEL = "hermes-70b";
    const config = resolveHermesConfig();
    expect(config).toEqual({
      baseUrl: "https://remote:443",
      apiKey: "sk-full",
      model: "hermes-70b",
    });
  });
});

describe("AgentBackend type", () => {
  it("accepts hermes", () => {
    const backend: AgentBackend = "hermes";
    expect(backend).toBe("hermes");
  });

  it("accepts openclaw", () => {
    const backend: AgentBackend = "openclaw";
    expect(backend).toBe("openclaw");
  });
});

describe("HermesConfig type", () => {
  it("has correct shape", () => {
    const config: HermesConfig = {
      baseUrl: "http://localhost",
      apiKey: "key",
      model: "model",
    };
    expect(config.baseUrl).toBe("http://localhost");
    expect(config.apiKey).toBe("key");
    expect(config.model).toBe("model");
  });
});
