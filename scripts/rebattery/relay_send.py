#!/usr/bin/env python3
"""Relay background send: runs `rebattery-mail send` for one approved draft, detached from the web request.

Started by the CRM after Alex confirms (lib/relay.ts queueSend) as: relay_send.py <mail_message id> <approver email>
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

import psycopg2

DSN = os.environ.get("RELAY_DSN", "host=/var/run/postgresql dbname=denchclaw")
CLI = "/usr/local/bin/rebattery-mail"
TIMEOUT = 900  # well past any normal send; the CLI's own provider timeouts are 30-180 s


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


if __name__ == "__main__":
    sys.exit(main(*(sys.argv[1:3] + ["", ""])[:2]))
