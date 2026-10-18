import { resolveWorkspaceRoot } from "@/lib/workspace";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ---------------------------------------------------------------------------
// Singleton watcher: one chokidar instance shared across all SSE connections.
// Uses polling (no native fs.watch FDs) so it doesn't compete with Next.js's
// own dev watcher for the macOS per-process file-descriptor limit.
// ---------------------------------------------------------------------------

type Listener = (type: string, relPath: string, root: string) => void;

let listeners = new Set<Listener>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sharedWatcher: any = null;
let sharedRoot: string | null = null;
let _watcherReady = false;

async function ensureWatcher(root: string) {
  if (sharedWatcher && sharedRoot === root) {return;}

  // Root changed (e.g. profile switch) -- close the old watcher first.
  if (sharedWatcher) {
    await sharedWatcher.close();
    sharedWatcher = null;
    sharedRoot = null;
    _watcherReady = false;
  }

  try {
    const chokidar = await import("chokidar");
    sharedRoot = root;
    sharedWatcher = chokidar.watch(root, {
      ignoreInitial: true,
      usePolling: true,
      interval: 1500,
      binaryInterval: 3000,
      ignored: [
        /(^|[\\/])node_modules([\\/]|$)/,
        /(^|[\\/])\.git([\\/]|$)/,
        /(^|[\\/])\.next([\\/]|$)/,
        /(^|[\\/])dist([\\/]|$)/,
        /\.duckdb\.wal$/,
        /\.duckdb\.tmp$/,
        // Internal state that doesn't affect the visible tree. These fire
        // constantly during chat streaming + tool calls and were causing
        // the tree (and its icons) to re-render on every SSE tick, which
        // manifested as the Tasks kanban icon briefly flipping colour.
        /(^|[\\/])\.openclaw[\\/]web-chat([\\/]|$)/,
        /(^|[\\/])\.openclaw[\\/]logs([\\/]|$)/,
        /(^|[\\/])\.openclaw[\\/]cron-runs([\\/]|$)/,
        /(^|[\\/])\.openclaw[\\/]gateway([\\/]|$)/,
      ],
      depth: 5,
    });

    sharedWatcher.on("all", (eventType: string, filePath: string) => {
      const rel = filePath.startsWith(root)
        ? filePath.slice(root.length + 1)
        : filePath;
      for (const fn of listeners) {fn(eventType, rel, root);}
    });

    sharedWatcher.once("ready", () => {_watcherReady = true;});

    sharedWatcher.on("error", () => {
      // Swallow; polling mode shouldn't hit EMFILE but be safe.
    });
  } catch {
    // chokidar unavailable -- listeners simply won't fire.
  }
}

function stopWatcherIfIdle() {
  if (listeners.size > 0 || !sharedWatcher) {return;}
  sharedWatcher.close();
  sharedWatcher = null;
  sharedRoot = null;
  _watcherReady = false;
}

/**
 * GET /api/workspace/watch
 *
 * Server-Sent Events endpoint that watches the workspace for file changes.
 * Falls back gracefully if chokidar is unavailable.
 */
export async function GET(req: Request) {
  const root = resolveWorkspaceRoot();
  if (!root) {
    return new Response("Workspace not found", { status: 404 });
  }

  const encoder = new TextEncoder();
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let cleanup = () => {};

  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode("event: connected\ndata: {}\n\n"));

      const listener: Listener = (_type, _rel, eventRoot) => {
        if (closed || eventRoot !== root) {return;}
        try {
          // Preserve every changed path. Tree refetches are already debounced
          // by the client; debouncing here silently lost all but the last file.
          const data = JSON.stringify({ type: _type, path: _rel, root });
          controller.enqueue(encoder.encode(`event: change\ndata: ${data}\n\n`));
        } catch { /* stream closed */ }
      };

      heartbeat = setInterval(() => {
        if (closed) {return;}
        try {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch { /* closed */ }
      }, 30_000);

      function teardown() {
        if (closed) {return;}
        closed = true;
        listeners.delete(listener);
        if (heartbeat) {clearInterval(heartbeat);}
        stopWatcherIfIdle();
      }

      cleanup = teardown;
      req.signal.addEventListener("abort", teardown, { once: true });

      listeners.add(listener);
      await ensureWatcher(root);
      // Abort/cancel may precede the asynchronous watcher import completing.
      if (closed) {
        stopWatcherIfIdle();
        return;
      }

      if (!sharedWatcher) {
        controller.enqueue(
          encoder.encode("event: error\ndata: {\"error\":\"File watching unavailable\"}\n\n"),
        );
      }
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
