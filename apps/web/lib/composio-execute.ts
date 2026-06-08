/**
 * Typed wrapper for `POST /v1/composio/tools/execute` on the Dench gateway.
 *
 * The gateway forwards Composio's v3.1 stateless tool execution; the
 * surface is small (tool slug + connected account id + arguments) but
 * the failure modes are interesting (429s during a 100k-message backfill,
 * tool-slug renames, transient gateway 5xx). This module wraps all of
 * that so `gmail-sync.ts` and `calendar-sync.ts` can stay focused on
 * the upsert pipeline.
 *
 * Key behaviours:
 *
 * - **Retries**: 429 / 502 / 503 / 504 / network errors → exponential
 *   backoff (1s, 2s, 4s, 8s, 16s, 30s; cap 6 attempts).
 * - **Abort signals**: passed through to `fetch`. Aborting cancels both
 *   the in-flight request and any pending retry timer.
 * - **No-connection errors**: surfaced as `ComposioToolNoConnectionError`
 *   so the caller can prompt for re-OAuth instead of looping forever.
 * - **Slug resolution cache**: `resolveToolSlug` falls back to
 *   `/v1/composio/tools/search` when a hard-coded slug is unknown to
 *   the upstream Composio (handles `GMAIL_LIST_MESSAGES` →
 *   `GMAIL_FETCH_EMAILS` style renames).
 */

import {
  resolveComposioApiKey,
  resolveComposioGatewayUrl,
} from "./composio";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExecuteToolOptions = {
  toolSlug: string;
  connectedAccountId: string;
  arguments: Record<string, unknown>;
  signal?: AbortSignal;
  /** Override the global retry cap for an individual call. */
  maxRetries?: number;
  /** Hint surfaced in error messages and metrics (e.g. "gmail-backfill-page"). */
  context?: string;
};

export type ExecuteToolResult<T = unknown> = {
  data: T;
  /** Number of retries before success (0 on first-try). */
  retries: number;
  /** Wall-clock ms spent including retries. */
  elapsedMs: number;
};

export class ComposioToolError extends Error {
  readonly status: number;
  readonly responseBody: string;
  readonly toolSlug: string;
  readonly retries: number;
  readonly retriable: boolean;

  constructor(params: {
    message: string;
    status: number;
    responseBody: string;
    toolSlug: string;
    retries: number;
    retriable: boolean;
  }) {
    super(params.message);
    this.name = "ComposioToolError";
    this.status = params.status;
    this.responseBody = params.responseBody;
    this.toolSlug = params.toolSlug;
    this.retries = params.retries;
    this.retriable = params.retriable;
  }
}

export class ComposioToolNoConnectionError extends ComposioToolError {
  constructor(toolSlug: string, message: string, responseBody: string) {
    super({
      message,
      status: 400,
      responseBody,
      toolSlug,
      retries: 0,
      retriable: false,
    });
    this.name = "ComposioToolNoConnectionError";
  }
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

const RETRY_STATUS = new Set<number>([408, 425, 429, 500, 502, 503, 504]);
// Substrings that Composio returns (lowercased) when the upstream OAuth
// connection is gone — either revoked by the provider, hand-deleted in
// Composio's dashboard, or expired without a refresh token.
//
// We classify these as `ComposioToolNoConnectionError` so callers
// (notably `tickPoller`) surface a "Reconnect from Integrations" toast
// instead of a generic 4xx/5xx that the silent-failure catch swallows.
//
// Additions are easy to discover after the fact: Composio's response
// body always lowercases cleanly via `body.toLowerCase()`, and the
// substring check is permissive on whitespace + punctuation. When in
// doubt, run the failing tool with curl and grep the response for a
// stable phrase before adding it here.
const NO_CONNECTION_HINTS = [
  "composio_account_selection_required",
  "no active connection",
  "no connection found",
  "connected_account_id is required",
  // Observed 2026-04 against a revoked Gmail OAuth connection — the
  // exact phrasing from Composio's `composio_client_error` body. Without
  // this, the error fell through as a generic ComposioToolError and the
  // poll loop swallowed it silently for days.
  "is not active or does not exist",
  // Defensive: catch slight wording variants Composio has used on other
  // toolkits (Slack/Notion) for the same root cause.
  "account is not active",
  "account does not exist",
  "connection has been disabled",
  "connection is disabled",
];
const DEFAULT_MAX_RETRIES = 6;
const FIRST_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;

function backoffMs(attempt: number): number {
  const base = FIRST_RETRY_DELAY_MS * 2 ** attempt;
  // Add up to 25% jitter so concurrent callers don't all retry on the
  // same tick after a transient gateway hiccup.
  const jitter = Math.random() * base * 0.25;
  return Math.min(MAX_RETRY_DELAY_MS, base + jitter);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Aborted"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Decide whether a Composio HTTP response is the "your account is gone,
 * reconnect" failure mode (vs. a transient or unrelated 4xx/5xx).
 *
 * Exported only so the unit tests can pin down the substring matrix in
 * `NO_CONNECTION_HINTS` without going through a full executeComposioTool
 * round-trip.
 */
export function isLikelyNoConnection(status: number, body: string): boolean {
  if (status !== 400 && status !== 404 && status !== 422) {return false;}
  const lower = body.toLowerCase();
  return NO_CONNECTION_HINTS.some((hint) => lower.includes(hint));
}

async function gatewayFetch(
  path: string,
  init: RequestInit,
): Promise<Response> {
  const apiKey = resolveComposioApiKey();
  if (!apiKey) {
    throw new Error("Dench Cloud API key is not configured.");
  }
  const url = `${resolveComposioGatewayUrl()}${path}`;
  const headers = new Headers({
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
    "xi-api-key": apiKey,
  });
  if (init.headers) {
    new Headers(init.headers).forEach((value, key) => {
      headers.set(key, value);
    });
  }
  return fetch(url, { ...init, headers });
}

// ---------------------------------------------------------------------------
// Public: execute
// ---------------------------------------------------------------------------

export async function executeComposioTool<T = unknown>(
  opts: ExecuteToolOptions,
): Promise<ExecuteToolResult<T>> {
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const startedAt = Date.now();
  let attempt = 0;
  let lastError: ComposioToolError | null = null;

  while (attempt <= maxRetries) {
    if (opts.signal?.aborted) {
      throw opts.signal.reason ?? new Error("Aborted");
    }

    let response: Response;
    try {
      response = await gatewayFetch("/v1/composio/tools/execute", {
        method: "POST",
        signal: opts.signal,
        body: JSON.stringify({
          tool_slug: opts.toolSlug,
          connected_account_id: opts.connectedAccountId,
          arguments: opts.arguments,
        }),
      });
    } catch (err) {
      // Network error / fetch threw before getting a response.
      if ((err as { name?: string }).name === "AbortError") {throw err;}
      lastError = new ComposioToolError({
        message: `Network error calling ${opts.toolSlug}: ${(err as Error).message}`,
        status: 0,
        responseBody: "",
        toolSlug: opts.toolSlug,
        retries: attempt,
        retriable: true,
      });
      if (attempt >= maxRetries) {throw lastError;}
      await sleep(backoffMs(attempt), opts.signal);
      attempt += 1;
      continue;
    }

    if (response.ok) {
      const data = (await response.json()) as T;
      return {
        data,
        retries: attempt,
        elapsedMs: Date.now() - startedAt,
      };
    }

    const body = await response.text().catch(() => "");
    if (isLikelyNoConnection(response.status, body)) {
      throw new ComposioToolNoConnectionError(
        opts.toolSlug,
        `No active Composio connection for ${opts.toolSlug}. Reconnect from the Integrations panel.`,
        body,
      );
    }

    const retriable = RETRY_STATUS.has(response.status);
    lastError = new ComposioToolError({
      message: `Composio ${opts.toolSlug} failed: HTTP ${response.status}${
        body ? ` — ${body.slice(0, 240)}` : ""
      }`,
      status: response.status,
      responseBody: body,
      toolSlug: opts.toolSlug,
      retries: attempt,
      retriable,
    });

    if (!retriable || attempt >= maxRetries) {
      throw lastError;
    }

    await sleep(backoffMs(attempt), opts.signal);
    attempt += 1;
  }

  // Loop should always throw before reaching here.
  throw (
    lastError ??
    new ComposioToolError({
      message: `Exhausted retries calling ${opts.toolSlug}.`,
      status: 0,
      responseBody: "",
      toolSlug: opts.toolSlug,
      retries: attempt,
      retriable: false,
    })
  );
}

// ---------------------------------------------------------------------------
// Tool-slug resolution + connection lookup
// ---------------------------------------------------------------------------

const slugCache = new Map<string, string>();

type ToolSearchResponse = {
  items?: Array<{ slug?: string; name?: string }>;
  tools?: Array<{ slug?: string; name?: string }>;
  data?: Array<{ slug?: string; name?: string }>;
};

/**
 * Try the requested slug verbatim; if Composio doesn't know it, fall back to
 * `POST /v1/composio/tools/search` with the toolkit slug + a free-text query
 * and pick the closest match. Caches successful resolutions in-process.
 */
export async function resolveToolSlug(params: {
  toolkitSlug: string;
  preferredSlugs: ReadonlyArray<string>;
  searchQuery?: string;
  signal?: AbortSignal;
}): Promise<string> {
  const cacheKey = `${params.toolkitSlug}::${params.preferredSlugs.join("|")}`;
  const cached = slugCache.get(cacheKey);
  if (cached) {return cached;}

  // Optimistic path: trust the first preferred slug for now. The actual call
  // will surface a hard 404/422 if Composio renamed it, and we'll re-resolve.
  if (params.preferredSlugs.length > 0) {
    const first = params.preferredSlugs[0];
    slugCache.set(cacheKey, first);
    return first;
  }

  const response = await gatewayFetch("/v1/composio/tools/search", {
    method: "POST",
    signal: params.signal,
    body: JSON.stringify({
      toolkit_slug: params.toolkitSlug,
      query: params.searchQuery ?? params.toolkitSlug,
      limit: 20,
    }),
  });
  if (!response.ok) {
    throw new Error(`Tool search for ${params.toolkitSlug} failed: HTTP ${response.status}`);
  }

  const json = (await response.json()) as ToolSearchResponse;
  const items = json.items ?? json.tools ?? json.data ?? [];
  for (const item of items) {
    const slug = typeof item.slug === "string" ? item.slug : null;
    if (!slug) {continue;}
    slugCache.set(cacheKey, slug);
    return slug;
  }
  throw new Error(
    `No matching tools found for ${params.toolkitSlug} (query: "${params.searchQuery ?? ""}")`,
  );
}

/**
 * Forget a cached slug — call when an `executeComposioTool` returned a
 * tool-not-found style error so the next attempt reaches `tools/search`.
 */
export function invalidateToolSlug(toolkitSlug: string, preferredSlugs: ReadonlyArray<string>): void {
  slugCache.delete(`${toolkitSlug}::${preferredSlugs.join("|")}`);
}

// ---------------------------------------------------------------------------
// Concurrency limiter — used by the sync runner to cap parallel tool calls.
// ---------------------------------------------------------------------------

/**
 * Tiny semaphore; replaces a heavier dep just for "max N in flight".
 *
 * ```ts
 * const limit = createConcurrencyLimiter(4);
 * await Promise.all(items.map((item) => limit(() => executeComposioTool({...}))));
 * ```
 */
export function createConcurrencyLimiter(maxConcurrent: number): <T>(fn: () => Promise<T>) => Promise<T> {
  if (maxConcurrent <= 0) {
    throw new Error("maxConcurrent must be > 0");
  }
  let active = 0;
  const queue: Array<() => void> = [];

  function next(): void {
    if (active >= maxConcurrent) {return;}
    const job = queue.shift();
    if (!job) {return;}
    active += 1;
    job();
  }

  return function limit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => {
        fn()
          .then((value) => {
            active -= 1;
            resolve(value);
            next();
          })
          .catch((err) => {
            active -= 1;
            reject(err);
            next();
          });
      });
      next();
    });
  };
}
