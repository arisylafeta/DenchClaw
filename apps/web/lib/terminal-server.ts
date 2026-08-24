import { WebSocketServer, type WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { chmodSync, existsSync } from "node:fs";

interface TerminalSession {
  pty: import("node-pty").IPty;
  ws: WebSocket;
}

const sessions = new Map<WebSocket, TerminalSession>();

const _g = globalThis as unknown as {
  __terminalWss?: WebSocketServer;
  __terminalDidFixSpawnHelper?: boolean;
  __terminalPort?: number;
};

let wss: WebSocketServer | null = _g.__terminalWss ?? null;
let didFixSpawnHelper = _g.__terminalDidFixSpawnHelper ?? false;

function ensureSpawnHelperExecutable() {
  if (didFixSpawnHelper || process.platform === "win32") return;
  didFixSpawnHelper = true;
  _g.__terminalDidFixSpawnHelper = true;
  try {
    const req = createRequire(import.meta.url);
    const pkgPath = req.resolve("node-pty/package.json");
    const pkgDir = dirname(pkgPath);
    const candidates = [
      join(pkgDir, "build", "Release", "spawn-helper"),
      join(pkgDir, "build", "Debug", "spawn-helper"),
      join(pkgDir, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        chmodSync(candidate, 0o755);
      }
    }
  } catch {
    // best-effort
  }
}

function defaultShell(): string {
  if (process.platform === "win32") {
    return process.env.ComSpec ?? "cmd.exe";
  }
  return process.env.SHELL ?? "/bin/zsh";
}

function shellArgs(shell: string): string[] {
  const name = shell.split("/").pop()?.toLowerCase() ?? "";
  if (process.platform !== "win32" && name === "zsh") {
    return ["-o", "nopromptsp"];
  }
  return [];
}

function spawnTerminal(ws: WebSocket, cols: number, rows: number, cwd?: string) {
  ensureSpawnHelperExecutable();

  let nodePty: typeof import("node-pty");
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    nodePty = require("node-pty") as typeof import("node-pty");
  } catch {
    ws.send(JSON.stringify({ type: "exit", exitCode: 1, signal: null }));
    return;
  }

  const shell = defaultShell();
  const spawnCwd = cwd || process.env.HOME || process.cwd();

  let pty: import("node-pty").IPty;
  try {
    pty = nodePty.spawn(shell, shellArgs(shell), {
      name: "xterm-256color",
      cols,
      rows,
      cwd: spawnCwd,
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([, v]) => v !== undefined,
        ),
      ) as Record<string, string>,
    });
  } catch {
    ws.send(JSON.stringify({ type: "exit", exitCode: 1, signal: null }));
    return;
  }

  const session: TerminalSession = { pty, ws };
  sessions.set(ws, session);

  pty.onData((data) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "output", data }));
    }
  });

  pty.onExit(({ exitCode, signal }) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "exit", exitCode, signal }));
    }
    sessions.delete(ws);
  });

  ws.send(JSON.stringify({ type: "ready", pid: pty.pid }));
}

function handleMessage(ws: WebSocket, raw: string) {
  let msg: { type: string; data?: string; cols?: number; rows?: number; cwd?: string };
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  const session = sessions.get(ws);

  switch (msg.type) {
    case "spawn": {
      if (session) {
        session.pty.kill();
        sessions.delete(ws);
      }
      spawnTerminal(ws, msg.cols ?? 80, msg.rows ?? 24, msg.cwd);
      break;
    }
    case "input": {
      if (session && msg.data) {
        session.pty.write(msg.data);
      }
      break;
    }
    case "resize": {
      if (session && msg.cols && msg.rows) {
        session.pty.resize(msg.cols, msg.rows);
      }
      break;
    }
  }
}

function handleConnection(ws: WebSocket, _req: IncomingMessage) {
  ws.on("message", (data) => {
    handleMessage(ws, data.toString());
  });

  ws.on("close", () => {
    const session = sessions.get(ws);
    if (session) {
      session.pty.kill();
      sessions.delete(ws);
    }
  });

  ws.on("error", () => {
    const session = sessions.get(ws);
    if (session) {
      session.pty.kill();
      sessions.delete(ws);
    }
  });
}

export function startTerminalServer(port: number) {
  if (wss) return;

  wss = new WebSocketServer({ port, host: "127.0.0.1" });
  _g.__terminalWss = wss;
  wss.on("connection", handleConnection);
  wss.on("listening", () => {
    _g.__terminalPort = port;
  });
  wss.on("error", (err) => {
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
      console.warn(`[terminal] Port ${port} in use, retrying on ${port + 1}`);
      wss = null;
      _g.__terminalWss = undefined;
      startTerminalServer(port + 1);
    }
  });
}

export function getTerminalPort(): number | null {
  return _g.__terminalPort ?? null;
}

export function stopTerminalServer() {
  if (!wss) return;
  for (const session of sessions.values()) {
    session.pty.kill();
  }
  sessions.clear();
  wss.close();
  wss = null;
  _g.__terminalWss = undefined;
}
