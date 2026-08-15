const READ_ATTEMPTS = 3;
const READ_TIMEOUT_MS = 15_000;
const RETRY_DELAYS_MS = [100, 250];
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  return input instanceof Request ? input.method.toUpperCase() : "GET";
}

function callerSignal(input: RequestInfo | URL, init?: RequestInit): AbortSignal | null {
  if (init?.signal) return init.signal;
  return input instanceof Request ? input.signal : null;
}

function wait(ms: number, signal: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }

    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs = READ_TIMEOUT_MS,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const upstreamSignal = callerSignal(input, init);
  if (upstreamSignal?.aborted) {
    throw upstreamSignal.reason ?? new DOMException("Aborted", "AbortError");
  }

  const controller = new AbortController();
  const forwardAbort = () => controller.abort(upstreamSignal?.reason);
  upstreamSignal?.addEventListener("abort", forwardAbort, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new DOMException(
      "Request timed out; the outcome may be unknown. Refresh before retrying.",
      "TimeoutError",
    )),
    timeoutMs,
  );

  try {
    return await fetcher(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    upstreamSignal?.removeEventListener("abort", forwardAbort);
  }
}

/**
 * Applies bounded resilience to idempotent platform reads.
 *
 * Mutations are deliberately passed through once. Retrying an ambiguous write
 * can duplicate side effects even when the first response was lost in transit.
 */
export async function platformAdminFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const method = requestMethod(input, init);
  if (method !== "GET" && method !== "HEAD") return fetchWithTimeout(input, init);

  const upstreamSignal = callerSignal(input, init);
  let lastError: unknown;

  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt += 1) {
    if (upstreamSignal?.aborted) {
      throw upstreamSignal.reason ?? new DOMException("Aborted", "AbortError");
    }

    try {
      const response = await fetchWithTimeout(input, init);
      if (!RETRYABLE_STATUSES.has(response.status) || attempt === READ_ATTEMPTS - 1) {
        return response;
      }
      await response.body?.cancel().catch(() => undefined);
      lastError = new Error(`Transient platform response (${response.status})`);
    } catch (error) {
      if (upstreamSignal?.aborted) throw error;
      lastError = error;
      if (attempt === READ_ATTEMPTS - 1) throw error;
    }

    await wait(RETRY_DELAYS_MS[attempt] ?? RETRY_DELAYS_MS.at(-1)!, upstreamSignal);
  }

  throw lastError;
}
