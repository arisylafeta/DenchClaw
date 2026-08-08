/**
 * Manual sync trigger — shared by the agent's `denchclaw_refresh_sync` /
 * `denchclaw_resync_full` tools (in `extensions/dench-ai-gateway/`) and
 * the workspace `SyncHealthBanner`'s "Refresh now" button.
 *
 * Why this exists alongside `/api/sync/poll-tick`:
 *
 * - `poll-tick` is the gateway-cron path. It demands a Bearer token
 *   matching the ReBattery Cloud API key — appropriate for the long-lived
 *   gateway daemon, but the browser can't read that key from the
 *   workspace state directory, so a UI "Refresh now" button can't use
 *   it.
 * - `refresh` is the user-initiated path. Loopback-only is enough
 *   security here: the same-origin browser is trusted (it's the user's
 *   own machine), the gateway daemon is also loopback-local, and any
 *   external traffic gets blocked by the host check exactly the way
 *   `poll-tick` does it. We deliberately do NOT require a Bearer here
 *   so the UI button can call it without smuggling secrets to the
 *   browser.
 *
 * Modes:
 *
 * - `incremental` (default) → `tickPoller()`. Cheap; 1–2 sec on a
 *   healthy connection. This is the "I just want my new emails" path.
 * - `backfill` → `startBackfill()`. Heavy; can run for minutes on a
 *   large mailbox. The "I just reconnected my Gmail / nothing's syncing
 *   right" path. Returns immediately (`backfill` runs in the background)
 *   so the caller doesn't block on a multi-minute SSE-driven flow.
 *
 * Concurrency:
 *
 * - `tickPoller()` is mutex-gated internally — overlapping incremental
 *   ticks are dropped, not queued. The route still returns 200 in that
 *   case so the UI doesn't surface a fake error when the gateway cron
 *   happens to land in the same second as the user's button click.
 * - `startBackfill()` is idempotent — calling it while one is already
 *   in flight returns `{ started: false, alreadyRunning: true }` and we
 *   surface that as `200 { ok: true, alreadyRunning: true }` so the UI
 *   can show "already syncing".
 */

import {
  getLastProgressEvent,
  isBackfillRunning,
  startBackfill,
  tickPoller,
} from "@/lib/sync-runner";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export type SyncRefreshMode = "incremental" | "backfill";

type RefreshRequestBody = {
  mode?: unknown;
};

/**
 * Mirrors `isLoopbackHost` from poll-tick exactly — same threat model,
 * same accepted hosts. Kept as a private copy rather than shared util
 * so a defensive change to one doesn't silently widen the other.
 */
function isLoopbackHost(rawHost: string | null): boolean {
  if (!rawHost) {return false;}
  const host = rawHost.split(",")[0]?.trim().toLowerCase();
  if (!host) {return false;}
  let bare = host;
  if (bare.startsWith("[")) {
    const closing = bare.indexOf("]");
    bare = closing > 0 ? bare.slice(1, closing) : bare;
  } else {
    const lastColon = bare.lastIndexOf(":");
    if (lastColon > 0 && /^\d+$/.test(bare.slice(lastColon + 1))) {
      bare = bare.slice(0, lastColon);
    }
  }
  return (
    bare === "localhost" ||
    bare === "127.0.0.1" ||
    bare === "::1" ||
    bare.startsWith("127.")
  );
}

function describeBadMode(raw: unknown): string {
  if (typeof raw === "string") {return raw;}
  if (typeof raw === "number" || typeof raw === "boolean") {return String(raw);}
  try {
    return JSON.stringify(raw);
  } catch {
    return "(unserializable)";
  }
}

function parseMode(raw: unknown): SyncRefreshMode | { error: string } {
  if (raw === undefined || raw === null) {return "incremental";}
  if (raw === "incremental" || raw === "backfill") {return raw;}
  return {
    error: `Invalid mode "${describeBadMode(raw)}" — expected "incremental" or "backfill".`,
  };
}

export async function POST(req: Request) {
  const hostHeader =
    req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (!isLoopbackHost(hostHeader)) {
    return Response.json(
      { error: "sync refresh is loopback-only" },
      { status: 403 },
    );
  }

  // Body is optional — a `POST` with no body defaults to incremental,
  // which is what both the UI button and the agent's most common case
  // want. We only error on a body that's explicitly present and
  // malformed; an empty body silently defaults so the route is
  // friendly to `fetch(url, { method: "POST" })` calls that don't
  // construct a JSON literal. We read text first because
  // `Content-Length` isn't reliably set by the WHATWG `Request`
  // constructor used in tests, and `req.json()` on an empty body
  // throws a confusing "Unexpected end of JSON input".
  let body: RefreshRequestBody = {};
  const raw = await req.text().catch(() => "");
  if (raw.trim().length > 0) {
    try {
      body = JSON.parse(raw) as RefreshRequestBody;
    } catch {
      return Response.json({ error: "Invalid JSON body." }, { status: 400 });
    }
  }

  const mode = parseMode(body.mode);
  if (typeof mode === "object") {
    return Response.json({ error: mode.error }, { status: 400 });
  }

  const ranAt = new Date().toISOString();

  if (mode === "backfill") {
    // Already-running case is success-shaped on purpose — the user's
    // intent ("a backfill should be happening") is satisfied either
    // way, no point making them dismiss an error toast.
    if (isBackfillRunning()) {
      return Response.json({
        ok: true,
        mode,
        ranAt,
        alreadyRunning: true,
        lastEvent: getLastProgressEvent(),
      });
    }
    const result = startBackfill();
    if (!result.started) {
      // `startBackfill` only refuses for a missing Gmail connection —
      // surface that as 409 Conflict so the caller can prompt for OAuth
      // instead of pretending the backfill is happening in the
      // background.
      return Response.json(
        {
          ok: false,
          mode,
          error: result.reason ?? "Backfill could not be started.",
        },
        { status: 409 },
      );
    }
    return Response.json({
      ok: true,
      mode,
      ranAt,
      started: true,
      lastEvent: getLastProgressEvent(),
    });
  }

  // Incremental path: skip the tick if a backfill is in progress
  // (matches `poll-tick`'s contract — the backfill will catch
  // everything the incremental tick would have).
  if (isBackfillRunning()) {
    return Response.json({
      ok: true,
      mode,
      ranAt,
      skipped: "backfill-in-progress",
      lastEvent: getLastProgressEvent(),
    });
  }

  try {
    await tickPoller();
  } catch (err) {
    return Response.json(
      {
        ok: false,
        mode,
        error: err instanceof Error ? err.message : "tickPoller failed",
      },
      { status: 500 },
    );
  }

  return Response.json({
    ok: true,
    mode,
    ranAt,
    lastEvent: getLastProgressEvent(),
  });
}
