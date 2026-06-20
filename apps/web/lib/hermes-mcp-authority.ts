import { readFile } from "node:fs/promises";

export type HermesMcpAuthority = {
  owner: "hermes";
  configPath: string;
  servers: string[];
};

export const HERMES_MCP_CONFIG_PATH = "/root/.hermes/config.yaml";

export async function readHermesMcpAuthority(): Promise<HermesMcpAuthority> {
  const servers: string[] = [];

  try {
    const config = await readFile(HERMES_MCP_CONFIG_PATH, "utf8");
    if (/^[ \t]{2}denchclaw:/m.test(config)) {
      servers.push("denchclaw");
    }
    if (/^[ \t]{2}exa:/m.test(config)) {
      servers.push("exa");
    }
    if (/^[ \t]{2}searxng:/m.test(config)) {
      servers.push("searxng");
    }
    if (/^[ \t]{2}supabase:/m.test(config)) {
      servers.push("supabase");
    }
    if (/^[ \t]{2}postmark:/m.test(config)) {
      servers.push("postmark");
    }
  } catch {
    // Keep callers stable while Hermes is temporarily unavailable.
  }

  return {
    owner: "hermes",
    configPath: HERMES_MCP_CONFIG_PATH,
    servers,
  };
}

export function isHermesDenchClawMcpAuthority(authority: HermesMcpAuthority): boolean {
  return authority.servers.includes("denchclaw");
}
