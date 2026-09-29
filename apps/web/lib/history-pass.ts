// Starts a one-off history pass for a trade (scripts/rebattery/bulk_trade_inbox_check.py --history)
// in the background. Server only. The script records its run in crm_bulk_trade_check_runs.

import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { join } from "node:path";

const SCRIPT = process.env.BULK_TRADES_CHECK_SCRIPT
  || "/root/.hermes/projects/denchclaw/scripts/rebattery/bulk_trade_inbox_check.py";
/** Run logs hold quotes from Alex's mail, so they stay in a root-only folder outside any repo. */
const LOG_DIR = process.env.BULK_TRADES_LOG_DIR || "/root/.hermes/workspace/logs/bulk-trades";

const LOT_ID = /^[A-Za-z0-9_.:-]{1,120}$/;

export function startHistoryPass(lotId: string): boolean {
  if (!LOT_ID.test(lotId)) return false;
  try {
    mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
    const log = openSync(join(LOG_DIR, `history-${lotId.replace(/[^A-Za-z0-9_-]/g, "_")}.log`), "a", 0o600);
    const child = spawn("/usr/bin/python3", [SCRIPT, "--history", lotId], {
      detached: true,
      stdio: ["ignore", log, log],
      env: { ...process.env, HOME: process.env.HOME || "/root", PATH: `/usr/local/bin:${process.env.PATH ?? ""}` },
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
