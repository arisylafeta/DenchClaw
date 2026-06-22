import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { resolveOpenClawStateDir } from "@/lib/workspace";
import { readHeartbeatSetting } from "@/lib/cron-heartbeat";

export const dynamic = "force-dynamic";

const CRON_DIR = join(resolveOpenClawStateDir(), "cron");

function resolveJobsFile(): string {
  if (process.env.DENCH_AGENT_BACKEND === "hermes") {
    const hermesHome = process.env.DENCH_HOME?.trim()
      || process.env.HERMES_HOME?.trim()
      || join(process.env.HOME || "/root", ".hermes");
    return join(hermesHome, "cron", "jobs.json");
  }
  return join(CRON_DIR, "jobs.json");
}

type CronStoreFile = {
  version: 1;
  jobs: Array<Record<string, unknown>>;
};

/** Read cron jobs.json, returning empty array if missing or invalid. */
function readJobsFile(): Array<Record<string, unknown>> {
  const jobsFile = resolveJobsFile();
  if (!existsSync(jobsFile)) {return [];}
  try {
    const raw = readFileSync(jobsFile, "utf-8");
    const parsed = JSON.parse(raw) as CronStoreFile;
    if (parsed && Array.isArray(parsed.jobs)) {return parsed.jobs;}
    return [];
  } catch {
    return [];
  }
}

/** Compute next wake time from job states (minimum nextRunAtMs among enabled jobs). */
function computeNextWakeAtMs(jobs: Array<Record<string, unknown>>): number | null {
  let min: number | null = null;
  for (const job of jobs) {
    if (job.enabled !== true) {continue;}

    const nextRunIso = typeof job.next_run_at === "string" ? Date.parse(job.next_run_at) : Number.NaN;
    if (Number.isFinite(nextRunIso)) {
      if (min === null || nextRunIso < min) {min = nextRunIso;}
      continue;
    }

    const state = job.state as Record<string, unknown> | undefined;
    if (!state) {continue;}
    const next = state.nextRunAtMs;
    if (typeof next === "number" && Number.isFinite(next)) {
      if (min === null || next < min) {min = next;}
    }
  }
  return min;
}

/**
 * Estimate when the next heartbeat will fire based on the most recent agent
 * session activity plus the configured interval. Returns null when no session
 * activity is available.
 */
function estimateNextHeartbeatMs(intervalMs: number): number | null {
  try {
    const agentsDir = join(resolveOpenClawStateDir(), "agents");
    if (!existsSync(agentsDir)) {return null;}

    const agentDirs = readdirSync(agentsDir, { withFileTypes: true });
    let latestHeartbeat: number | null = null;

    for (const d of agentDirs) {
      if (!d.isDirectory()) {continue;}
      const storePath = join(agentsDir, d.name, "sessions", "sessions.json");
      if (!existsSync(storePath)) {continue;}
      try {
        const raw = readFileSync(storePath, "utf-8");
        const store = JSON.parse(raw) as Record<string, { updatedAt?: number }>;
        for (const [key, entry] of Object.entries(store)) {
          if (key.startsWith("agent:") && !key.includes(":cron:") && entry.updatedAt) {
            if (latestHeartbeat === null || entry.updatedAt > latestHeartbeat) {
              latestHeartbeat = entry.updatedAt;
            }
          }
        }
      } catch {
        // skip
      }
    }

    if (latestHeartbeat) {return latestHeartbeat + intervalMs;}
  } catch {
    // ignore
  }
  return null;
}

/**
 * Read heartbeat config from openclaw.json + estimate next due from agent sessions.
 * Returns interval, raw config string, and estimated next-fire timestamp.
 */
function readHeartbeatInfo(): { intervalMs: number; nextDueEstimateMs: number | null; every: string } {
  const setting = readHeartbeatSetting();
  return {
    intervalMs: setting.intervalMs,
    nextDueEstimateMs: estimateNextHeartbeatMs(setting.intervalMs),
    every: setting.raw,
  };
}

/** GET /api/cron/jobs -- list all cron jobs with heartbeat & status info */
export async function GET() {
  const jobs = readJobsFile();
  const heartbeat = readHeartbeatInfo();
  const nextWakeAtMs = computeNextWakeAtMs(jobs);

  return Response.json({
    jobs,
    heartbeat,
    cronStatus: {
      enabled: jobs.length > 0,
      nextWakeAtMs,
    },
  });
}
