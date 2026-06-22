import { resolveDenchPackageRoot as _resolveDenchPackageRoot } from "./runtime-roots";

/** Monorepo / DenchClaw package root (has package.json + assets/seed/workspace.duckdb). */
export function resolveDenchPackageRoot(): string | null {
  return _resolveDenchPackageRoot();
}
