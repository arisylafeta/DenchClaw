/**
 * Two callable agent tools that let the user (via the chat agent) ask
 * for an immediate Gmail/Calendar sync without waiting for the gateway
 * cron's next 5-minute tick:
 *
 *   - `denchclaw_refresh_sync`  → cheap incremental tick (`tickPoller`).
 *   - `denchclaw_resync_full`   → full backfill (`startBackfill`).
 *
 * Both tools POST to the workspace's `/api/sync/refresh` route, which
 * is loopback-only and unauthenticated by design (see the route file
 * for the threat-model rationale). The route is also what the
 * `SyncHealthBanner`'s "Refresh now" button calls, so we have a single
 * code path for "user-initiated sync."
 *
 * Why two tools instead of one tool with a `mode` parameter:
 *   The model picks tools by name + description. Two narrow tools with
 *   targeted descriptions ("incremental, fast" vs "full re-import,
 *   heavy") make the agent's decision crisp; one tool with a `mode`
 *   parameter would need the agent to reason about both the name and
 *   the parameter on every call, which empirically leads to occasional
 *   wrong-mode invocations.
 *
 * The execute handlers return short, human-readable text content so the
 * agent can repeat the result back to the user verbatim ("Synced 3 new
 * emails." / "Backfill started — N messages so far.").
 */

import type { AnyAgentTool } from "openclaw/plugin-sdk";
import { resolveSyncTriggerConfig, resolveWebBaseUrl } from "./sync-trigger.js";

const REFRESH_TOOL_NAME = "denchclaw_refresh_sync";
const RESYNC_TOOL_NAME = "denchclaw_resync_full";
const REFRESH_TIMEOUT_MS = 30_000;
// Backfill returns immediately (background work) but `startBackfill`
// itself acquires the runner mutex synchronously, so we still want a
// generous timeout in case the schema-migration step at the front is
// slow on a cold workspace.
const RESYNC_TIMEOUT_MS = 60_000;

type UnknownRecord = Record<string, unknown>;

/**
 * Shape returned by `/api/sync/refresh` on success. Loose because the
 * route may add fields over time (e.g. `alreadyRunning`, `skipped`,
 * `started`); we surface anything we receive without strictly typing
 * every variant.
 */
type RefreshResponse = {
  ok?: boolean;
  mode?: "incremental" | "backfill";
  ranAt?: string;
  lastEvent?: {
    phase?: string;
    message?: string;
    messagesProcessed?: number;
    peopleProcessed?: number;
    companiesProcessed?: number;
    threadsProcessed?: number;
    eventsProcessed?: number;
    error?: string;
    source?: "gmail" | "calendar";
  } | null;
  alreadyRunning?: boolean;
  started?: boolean;
  skipped?: string;
  error?: string;
};

const REFRESH_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;

function jsonResult(payload: unknown, details?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    details: details ?? (payload as Record<string, unknown>),
  };
}

/**
 * Build a one-line summary of a refresh response. Used as the `text`
 * the agent reads back. We keep this terse on purpose — the agent
 * will paraphrase, and a long blob would just bloat its context.
 */
function summarize(mode: "incremental" | "backfill", body: RefreshResponse): string {
  if (body.ok === false) {
    return `Sync ${mode} failed: ${body.error ?? "unknown error"}`;
  }
  if (body.alreadyRunning) {
    return `A ${mode} sync is already running — no new tick started.`;
  }
  if (body.skipped === "backfill-in-progress") {
    return "Skipped incremental tick because a full backfill is currently in progress.";
  }
  const evt = body.lastEvent;
  if (evt?.phase === "error") {
    return `Sync ${mode} reported an error: ${evt.error ?? evt.message ?? "unknown"}`;
  }
  if (mode === "incremental") {
    const newMessages = evt?.messagesProcessed ?? 0;
    const newEvents = evt?.eventsProcessed ?? 0;
    if (newMessages === 0 && newEvents === 0) {
      return "Incremental sync ran — no new emails or calendar events since the last tick.";
    }
    const parts: string[] = [];
    if (newMessages > 0) {
      parts.push(`${newMessages} new email${newMessages === 1 ? "" : "s"}`);
    }
    if (newEvents > 0) {
      parts.push(`${newEvents} new event${newEvents === 1 ? "" : "s"}`);
    }
    return `Synced ${parts.join(" and ")}.`;
  }
  // backfill
  if (body.started) {
    return "Full backfill started — Gmail and Calendar are re-importing in the background.";
  }
  return "Full backfill request acknowledged.";
}

async function callRefreshRoute(
  webBaseUrl: string,
  mode: "incremental" | "backfill",
  timeoutMs: number,
): Promise<{ status: number; body: RefreshResponse }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${webBaseUrl}/api/sync/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ mode }),
      signal: controller.signal,
    });
    const text = await res.text();
    let body: RefreshResponse = {};
    if (text.trim()) {
      try {
        body = JSON.parse(text) as RefreshResponse;
      } catch {
        body = { error: text.slice(0, 240) };
      }
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the `denchclaw_refresh_sync` tool — the lightweight incremental
 * tick. Equivalent to one beat of the gateway's 5-min cron, but on
 * demand.
 */
export function createRefreshSyncTool(api: any): AnyAgentTool {
  const webBaseUrl = resolveWebBaseUrl(api, resolveSyncTriggerConfig(api));
  return {
    name: REFRESH_TOOL_NAME,
    label: "Refresh Gmail/Calendar sync",
    description:
      "Trigger an incremental Gmail and Calendar sync tick right now. Use this when the user asks to refresh, sync now, pull new emails, or check whether anything new has arrived. Cheap and fast (1-2 seconds). For a full re-import use denchclaw_resync_full instead.",
    parameters: REFRESH_PARAMETERS,
    async execute(_toolCallId: string, _input: UnknownRecord) {
      try {
        const { status, body } = await callRefreshRoute(
          webBaseUrl,
          "incremental",
          REFRESH_TIMEOUT_MS,
        );
        if (status >= 400) {
          return jsonResult(
            {
              error: body.error ?? `Refresh failed (HTTP ${status}).`,
              mode: "incremental",
            },
            { status: "error", httpStatus: status },
          );
        }
        return {
          content: [{ type: "text" as const, text: summarize("incremental", body) }],
          details: { mode: "incremental", response: body },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult(
          { error: `Refresh request failed: ${message}`, mode: "incremental" },
          { status: "error" },
        );
      }
    },
  } as AnyAgentTool;
}

/**
 * Build the `denchclaw_resync_full` tool — full Gmail + Calendar
 * backfill. Heavier than the incremental tick; expected use cases are
 * "I just reconnected my Gmail account" or "incremental refresh isn't
 * catching what I'm seeing in Gmail."
 */
export function createResyncFullTool(api: any): AnyAgentTool {
  const webBaseUrl = resolveWebBaseUrl(api, resolveSyncTriggerConfig(api));
  return {
    name: RESYNC_TOOL_NAME,
    label: "Full Gmail/Calendar resync",
    description:
      "Trigger a full Gmail and Calendar backfill — re-imports messages and events from scratch. Use this only when the user explicitly asks for a full resync, after they have reconnected an account, or when the incremental refresh (denchclaw_refresh_sync) repeatedly fails to surface messages they expect to see. Heavier than incremental sync; runs in the background.",
    parameters: REFRESH_PARAMETERS,
    async execute(_toolCallId: string, _input: UnknownRecord) {
      try {
        const { status, body } = await callRefreshRoute(webBaseUrl, "backfill", RESYNC_TIMEOUT_MS);
        if (status >= 400) {
          return jsonResult(
            {
              error: body.error ?? `Resync failed (HTTP ${status}).`,
              mode: "backfill",
            },
            { status: "error", httpStatus: status },
          );
        }
        return {
          content: [{ type: "text" as const, text: summarize("backfill", body) }],
          details: { mode: "backfill", response: body },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult(
          { error: `Resync request failed: ${message}`, mode: "backfill" },
          { status: "error" },
        );
      }
    },
  } as AnyAgentTool;
}

/**
 * Register both tools on the OpenClaw plugin API. Idempotent only via
 * the caller — usually invoked once from the plugin's `register`
 * function. Returns the tool names so the caller can log them.
 */
export function registerSyncRefreshTools(api: any): string[] {
  const refresh = createRefreshSyncTool(api);
  const resync = createResyncFullTool(api);
  api.registerTool(refresh, { name: REFRESH_TOOL_NAME, optional: true });
  api.registerTool(resync, { name: RESYNC_TOOL_NAME, optional: true });
  return [refresh.name, resync.name];
}
