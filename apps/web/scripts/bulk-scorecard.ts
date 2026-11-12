/**
 * The bulk scorecard (slice 6, docs/bulk-relay-system/scorecard.md), read only. Prints the eleven measures for the last
 * full week, the week before and the quarter to date, then the daily housekeeping the database is missing. With
 * --message it also writes the Monday message (short, WhatsApp-ready) to that file. It sends nothing and writes nothing
 * to the database: every connection is opened read-only and every query runs in a read-only transaction.
 *
 *   cd apps/web && node --conditions=react-server --import tsx scripts/bulk-scorecard.ts
 *   ... scripts/bulk-scorecard.ts --message /tmp/scorecard-monday.txt
 *   ... scripts/bulk-scorecard.ts --week 2026-12-07          # the week holding that date
 *   ... scripts/bulk-scorecard.ts --now 2027-01-11T08:00:00Z # as if run then (replays; the database's own date stays)
 *
 * DATABASE_URL picks the database, as for the web app (default: the local socket, database denchclaw).
 */
import { writeFileSync } from "node:fs";

function arg(name: string): string | null {
  const at = process.argv.indexOf(name);
  if (at === -1) return null;
  const value = process.argv[at + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value.`);
  return value;
}

async function main() {
  // node-postgres reads PGOPTIONS for every new connection, before any query runs.
  process.env.PGOPTIONS = "-c default_transaction_read_only=on";
  const { pgPool } = await import("../lib/postgres");
  const { loadScorecard, housekeeping } = await import("../lib/crm-postgres/bulk-scorecard");
  const { mondayMessage, scorecardText } = await import("../lib/bulk-scorecard");
  try {
    const nowArg = arg("--now");
    const now = nowArg ? new Date(nowArg) : new Date();
    if (Number.isNaN(now.getTime())) throw new Error("--now is not a date.");
    const card = await loadScorecard(now, arg("--week"));
    const house = await housekeeping();
    const lines = [scorecardText(card), "", "Daily housekeeping (not scheduled; see scorecard.md):"];
    lines.push(house.lapsed.count
      ? `- bulk_matches_expire() has not run: ${house.lapsed.count} reservation${house.lapsed.count === 1 ? " is" : "s are"} past ${house.lapsed.count === 1 ? "its" : "their"} last day and still marked offered (oldest ${house.lapsed.oldest}).`
      : "- bulk_matches_expire(): nothing waiting. No reservation is past its last day and still marked offered.");
    lines.push(house.behind.count
      ? `- bulk_stage_check_all() has not run: ${house.behind.count} open listing${house.behind.count === 1 ? " shows" : "s show"} a stage the log has not caught up with${house.behind.holdsEnded ? ` (${house.behind.holdsEnded} with a hold that ended and no stage event)` : ""}. For example: ${house.behind.examples.map((e) => `${e.title} (${e.logged ?? "none"} logged, ${e.now ?? "none"} now)`).join("; ")}.`
      : "- bulk_stage_check_all(): nothing waiting. Every open listing's logged stage matches its stage now.");
    console.log(lines.join("\n"));
    const path = arg("--message");
    if (path) {
      writeFileSync(path, `${mondayMessage(card)}\n`);
      console.log(`\nMonday message written to ${path}. Nothing was sent.`);
    }
  } finally {
    await pgPool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
