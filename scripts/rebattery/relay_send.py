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


def claim_due(conn) -> list[dict]:
    """Takes every due schedule off its draft in one statement and returns what each one was."""
    with conn.cursor() as cur:
        cur.execute("""with d as (
              select id, personalization->'scheduled_send' as s, updated_at from mail_message
              where state = 'draft' and personalization ? 'scheduled_send'
                and (personalization->'scheduled_send'->>'at')::timestamptz <= now()
              for update skip locked)
            update mail_message m set personalization = m.personalization - 'scheduled_send' from d where m.id = d.id
            returning m.id, d.s->>'by', (d.s->>'at')::timestamptz,
              coalesce(d.updated_at = (d.s->>'version')::timestamptz, false), coalesce(array_to_string(m.to_emails, ', '), '')""")
        rows = [{"id": r[0], "by": r[1], "at": r[2], "same_version": r[3], "to": r[4]} for r in cur.fetchall()]
    conn.commit()
    return rows


def run_due() -> int:
    conn = psycopg2.connect(DSN)
    try:
        rows = claim_due(conn)
        now = datetime.now(timezone.utc)
        failed = 0
        for row in rows:
            problem = decide(row, now)
            if problem:
                note(conn, row["id"], problem)
            elif main(row["id"], row["by"]) == 0:
                continue
            failed += 1
            print(f"Scheduled email to {row['to'] or 'unknown'} did not send. Open Relay Review to see why.")
        return 1 if failed else 0
    finally:
        conn.close()


if __name__ == "__main__":
    if sys.argv[1:2] == ["--due"]:
        sys.exit(run_due())
    sys.exit(main(*(sys.argv[1:3] + ["", ""])[:2]))
