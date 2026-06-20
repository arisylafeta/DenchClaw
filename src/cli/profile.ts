import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import { isValidProfileName } from "./profile-utils.js";

export const DENCHCLAW_PROFILE = "dench";
const DENCHCLAW_STATE_DIRNAME = ".openclaw-dench";

export type CliProfileParseResult =
  | { ok: true; profile: string | null; argv: string[] }
  | { ok: false; error: string };

function takeValue(
  raw: string,
  next: string | undefined,
): {
  value: string | null;
  consumedNext: boolean;
} {
  if (raw.includes("=")) {
    const [, value] = raw.split("=", 2);
    const trimmed = (value ?? "").trim();
    return { value: trimmed || null, consumedNext: false };
  }
  const trimmed = (next ?? "").trim();
  return { value: trimmed || null, consumedNext: Boolean(next) };
}

export function parseCliProfileArgs(argv: string[]): CliProfileParseResult {
  if (argv.length < 2) {
    return { ok: true, profile: null, argv };
  }

  const out: string[] = argv.slice(0, 2);
  let profile: string | null = null;
  let sawCommand = false;

  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) {
      continue;
    }

    if (sawCommand) {
      out.push(arg);
      continue;
    }

    if (arg === "--dev") {
      profile = "dev";
      continue;
    }

    if (arg === "--profile" || arg.startsWith("--profile=")) {
      const next = args[i + 1];
      const { value, consumedNext } = takeValue(arg, next);
      if (consumedNext) {
        i += 1;
      }
      if (!value) {
        return { ok: false, error: "--profile requires a value" };
      }
      if (!isValidProfileName(value)) {
        return {
          ok: false,
          error: 'Invalid --profile (use letters, numbers, "_", "-" only)',
        };
      }
      profile = value;
      continue;
    }

    if (!arg.startsWith("-")) {
      sawCommand = true;
      out.push(arg);
      continue;
    }

    out.push(arg);
  }

  return { ok: true, profile, argv: out };
}

function resolveProfileStateDir(
  env: Record<string, string | undefined>,
  homedir: () => string,
): string {
  const explicitStateDir = env.OPENCLAW_STATE_DIR?.trim();
  if (explicitStateDir) return path.resolve(explicitStateDir);
  const denchHome = env.DENCH_HOME?.trim();
  if (denchHome) return path.join(path.resolve(denchHome), "profiles", "default");
  return path.join(
    resolveRequiredHomeDir(env as NodeJS.ProcessEnv, homedir),
    DENCHCLAW_STATE_DIRNAME,
  );
}

export function applyCliProfileEnv(params: {
  profile?: string;
  env?: Record<string, string | undefined>;
  homedir?: () => string;
}): {
  requestedProfile: string | null;
  effectiveProfile: string;
  stateDir: string;
  warning?: string;
} {
  const env = params.env ?? (process.env as Record<string, string | undefined>);
  const homedir = params.homedir ?? os.homedir;
  const requestedProfile = (params.profile?.trim() || env.OPENCLAW_PROFILE?.trim() || null) ?? null;
  const profile = DENCHCLAW_PROFILE;

  // DenchClaw always runs in the pinned profile/state path.
  env.OPENCLAW_PROFILE = profile;

  const stateDir = resolveProfileStateDir(env, homedir);
  env.OPENCLAW_STATE_DIR = stateDir;
  const configPath = path.join(stateDir, "openclaw.json");
  env.OPENCLAW_CONFIG_PATH = configPath;

  if (!env.DENCH_CLOUD_API_KEY) {
    try {
      const authPath = path.join(stateDir, "agents", "main", "agent", "auth-profiles.json");
      if (existsSync(authPath)) {
        const raw = JSON.parse(readFileSync(authPath, "utf-8"));
        const key = raw?.profiles?.["dench-cloud:default"]?.key;
        if (typeof key === "string" && key.trim()) {
          env.DENCH_CLOUD_API_KEY = key.trim();
        }
      }
    } catch {
      // Best-effort; plugins fall back to auth-profiles.json resolution.
    }
  }

  const warning =
    requestedProfile && requestedProfile !== profile
      ? `Ignoring requested profile '${requestedProfile}'; DenchClaw always uses --profile ${DENCHCLAW_PROFILE}.`
      : undefined;

  return {
    requestedProfile,
    effectiveProfile: profile,
    stateDir,
    warning,
  };
}
