#!/usr/bin/env python3
"""Relay background send: runs `rebattery-mail send` for one approved draft, detached from the web request.

Started by the CRM after Alex confirms (lib/relay.ts queueSend) as: relay_send.py <mail_message id> <approver email>
Send later: `relay_send.py --due` (cron, every minute) sends each draft whose personalization.scheduled_send time has
come (set by lib/relay.ts scheduleSend), through the same path. It claims a schedule by removing it, so a draft is
tried once; it refuses a draft edited after scheduling (the pinned version differs) or one more than MISSED_AFTER late.
Prints one line per scheduled email that did not go, nothing otherwise.
The mail CLI owns the send and its safety gates (approval digest, reply check, suppression, idempotency claim)
and records failures after its claim. This runner only adds what the CLI cannot: a refusal BEFORE the claim leaves
the draft untouched, so the reason is stored in personalization.send_failure for Relay to show. The field is not
part of the approval digest.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone

import psycopg2

DSN = os.environ.get("RELAY_DSN", "host=/var/run/postgresql dbname=denchclaw")
CLI = "/usr/local/bin/rebattery-mail"
TIMEOUT = 900  # well past any normal send; the CLI's own provider timeouts are 30-180 s
MISSED_AFTER = timedelta(hours=6)  # a send-later time this far gone (runner down) waits for Alex instead


def note(conn, message_id: str, failure: dict | None) -> None:
    with conn.cursor() as cur:
        if failure is None:
            cur.execute("update mail_message set personalization = personalization - 'send_failure' where id = %s and state = 'draft'", (message_id,))
        else:
            cur.execute("""update mail_message set personalization = jsonb_set(coalesce(personalization, '{}'::jsonb), '{send_failure}', %s::jsonb, true)
                where id = %s and state = 'draft'""", (json.dumps(failure), message_id))
    conn.commit()


def refusal(stdout: str, stderr: str) -> dict:
    for text in (stdout, stderr):
        start = text.find("{")
        if start != -1:
            try:
                data = json.loads(text[start:])
                return {"reason": data.get("refused") or data.get("error") or "send_failed", "detail": data}
            except ValueError:
                pass
    line = (stderr or stdout).strip().splitlines()[-1:] or ["send_failed"]
    return {"reason": "send_failed", "detail": {"message": line[0][:300]}}


def main(message_id: str, approver: str) -> int:
    if not re.fullmatch(r"[\w:.-]{1,200}", message_id) or "@" not in approver:
        return 2
    conn = psycopg2.connect(DSN)
    try:
        note(conn, message_id, None)
        try:
            result = subprocess.run([CLI, "send", "--apply", "--approved-by", approver, "--", message_id],
                                    text=True, capture_output=True, timeout=TIMEOUT, check=False)
        except subprocess.TimeoutExpired:
            # The CLI marks a claimed message unknown itself; a draft that never got claimed gets the reason here.
            note(conn, message_id, {"reason": "send_timed_out", "detail": {}})
            return 1
        if result.returncode:
            note(conn, message_id, refusal(result.stdout or "", result.stderr or ""))
            return 1
        return 0
    finally:
        conn.close()


def decide(row: dict, now: datetime) -> dict | None:
    """What to do with one claimed schedule: None to send it, else the failure to record on the draft."""
    if not row["same_version"]:
        return {"reason": "schedule_changed", "detail": {"at": row["at"]}}
    if now - row["at"] > MISSED_AFTER:
        return {"reason": "schedule_missed", "detail": {"at": row["at"]}}
    if not row["by"] or "@" not in row["by"]:
        return {"reason": "schedule_invalid", "detail": {}}
    return None


RECLAIM_AFTER = timedelta(minutes=20)  # a claim this old was left by a runner that died; the next run retries it
AT_SQL = "(case when m.personalization->'scheduled_send'->>'at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' then (m.personalization->'scheduled_send'->>'at')::timestamptz end)"


def claim_next(conn) -> dict | None:
    """Claims the next due schedule (one row per transaction) by stamping claimed_at, keeping the pin so a runner that
    dies mid-way is retried. Only drafts Relay still holds count: a draft dropped by Done or a re-draft never sends.
    same_version compares the pinned version and attachments with the draft as it is now, just before sending."""
    with conn.cursor() as cur:
        cur.execute(f"""with d as (
              select m.id from mail_message m
              where m.state = 'draft' and m.personalization ? 'scheduled_send' and {AT_SQL} <= now()
                and exists (select 1 from relay_draft rd where rd.mail_message_id = m.id and rd.state in ('draft','gmail'))
                and coalesce((m.personalization->'scheduled_send'->>'claimed_at')::timestamptz, '-infinity') < now() - %s::interval
              order by {AT_SQL} limit 1
              for update of m skip locked)
            update mail_message m set personalization = jsonb_set(m.personalization, '{{scheduled_send,claimed_at}}', to_jsonb(now()), true)
            from d where m.id = d.id
            returning m.id, m.personalization->'scheduled_send'->>'by', {AT_SQL},
              coalesce(m.updated_at = (m.personalization->'scheduled_send'->>'version')::timestamptz
                and coalesce(m.personalization->'scheduled_send'->'attachments', 'null'::jsonb) = coalesce(m.personalization->'attachments', 'null'::jsonb), false)""",
                    (f"{int(RECLAIM_AFTER.total_seconds())} seconds",))
        r = cur.fetchone()
    conn.commit()
    return {"id": r[0], "by": r[1], "at": r[2], "same_version": r[3]} if r else None


def unpin(conn, message_id: str) -> None:
    with conn.cursor() as cur:
        cur.execute("update mail_message set personalization = personalization - 'scheduled_send' where id = %s", (message_id,))
    conn.commit()


def run_due(limit: int = 50) -> int:
    """Sends due scheduled drafts one at a time. Per-email failures are recorded on the draft and printed (no
    addresses); the exit code is non-zero only when the runner itself breaks."""
    conn = psycopg2.connect(DSN)
    try:
        for _ in range(limit):
            row = claim_next(conn)
            if not row:
                break
            problem = decide(row, datetime.now(timezone.utc))
            if problem:
                note(conn, row["id"], problem)
                ok = False
            else:
                ok = main(row["id"], row["by"]) == 0
            unpin(conn, row["id"])
            if not ok:
                print("A scheduled Relay email did not send. Open Relay Review to see why.")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    if sys.argv[1:2] == ["--due"]:
        sys.exit(run_due())
    sys.exit(main(*(sys.argv[1:3] + ["", ""])[:2]))
