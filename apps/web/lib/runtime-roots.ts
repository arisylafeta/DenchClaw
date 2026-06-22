import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Runtime root resolvers
//
// Problem: process.cwd() is unreliable in standalone Next.js deployments
// because CWD points to <stateDir>/web-runtime/app, not the repo root.
// These resolvers use a validated fallback chain:
//   1. Explicit env var
//   2. import.meta.url (module-relative)
//   3. process.cwd() (last resort)
//   4. Validate by checking marker files
//   5. Return null or throw with diagnostic if not found
// ---------------------------------------------------------------------------

function walkUpLookingFor(
  startDir: string,
  predicate: (dir: string) => boolean,
  maxSteps = 10,
): string | null {
  let dir = startDir;
  for (let i = 0; i < maxSteps; i += 1) {
    if (predicate(dir)) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return null;
}

function resolveFromMetaUrl(predicate: (dir: string) => boolean): string | null {
  try {
    const modulePath = fileURLToPath(import.meta.url);
    return walkUpLookingFor(dirname(modulePath), predicate, 10);
  } catch {
    return null;
  }
}

function resolveFromCwd(predicate: (dir: string) => boolean): string | null {
  try {
    return walkUpLookingFor(process.cwd(), predicate, 10);
  } catch {
    return null;
  }
}

function resolveRoot(
  envVar: string | undefined,
  predicate: (dir: string) => boolean,
): string | null {
  if (envVar) {
    const trimmed = envVar.trim();
    if (trimmed && existsSync(trimmed) && predicate(trimmed)) {
      return trimmed;
    }
  }
  const fromModule = resolveFromMetaUrl(predicate);
  if (fromModule) {
    return fromModule;
  }
  const fromCwd = resolveFromCwd(predicate);
  if (fromCwd) {
    return fromCwd;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Seed assets root (assets/seed/workspace.duckdb)
// ---------------------------------------------------------------------------

const SEED_MARKER = join("assets", "seed", "workspace.duckdb");

function isSeedAssetsRoot(dir: string): boolean {
  return existsSync(join(dir, SEED_MARKER));
}

/** Directory containing assets/seed/ (e.g. repo root or copied runtime app dir). */
export function resolveSeedAssetsRoot(): string | null {
  return resolveRoot(process.env.DENCH_SEED_ROOT, isSeedAssetsRoot);
}

// ---------------------------------------------------------------------------
// Bundled extensions root (extensions/shared/ or any bundled extension)
// ---------------------------------------------------------------------------

function isExtensionsRoot(dir: string): boolean {
  return existsSync(join(dir, "extensions", "shared"));
}

/** Directory containing extensions/ (e.g. repo root or copied runtime app dir). */
export function resolveBundledExtensionsRoot(): string | null {
  return resolveRoot(process.env.DENCH_EXTENSIONS_ROOT, isExtensionsRoot);
}

// ---------------------------------------------------------------------------
// Package / repo root (has package.json + assets/seed/workspace.duckdb)
// ---------------------------------------------------------------------------

function isPackageRoot(dir: string): boolean {
  return isSeedAssetsRoot(dir);
}

/** Monorepo / DenchClaw package root (has assets/seed/workspace.duckdb). */
export function resolveDenchPackageRoot(): string | null {
  return resolveRoot(process.env.DENCH_PACKAGE_ROOT, isPackageRoot);
}

// ---------------------------------------------------------------------------
// Runtime app root (the running Next.js app directory)
// ---------------------------------------------------------------------------

function isRuntimeAppRoot(dir: string): boolean {
  return existsSync(join(dir, "server.js")) || existsSync(join(dir, ".next"));
}

/** The running Next.js app directory (e.g. standalone app dir). */
export function resolveRuntimeAppRoot(): string | null {
  return resolveRoot(process.env.DENCH_RUNTIME_APP_ROOT, isRuntimeAppRoot);
}
