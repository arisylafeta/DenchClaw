#!/usr/bin/env python3
"""Relay agent job runner: runs the mail agent on one queued job and stores its JSON result.

Started detached by the CRM (lib/relay.ts startJob, startDealJob) as: relay_job.py <job id>
The prompt is in /srv/rebattery-data/relay-jobs/<id>/prompt.txt. A reply job runs Mailvin, which may read the CRM and
build files in that folder but never writes mail or data; the CRM turns its 'ready' result into drafts. A deal job
(note starting "[deal:") runs Matcha, which creates or updates the bulk listing under its recipe and never sends mail;
the CRM links the email to that deal. This runner only updates relay_job.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

import psycopg2

DSN = os.environ.get("RELAY_DSN", "host=/var/run/postgresql dbname=denchclaw")
JOB_ROOT = Path("/srv/rebattery-data/relay-jobs")
BUDGET_SECONDS = 900


def update(conn, job_id: str, **fields) -> None:
    steps = fields.pop("step", None)
    sets, values = [], []
    for key, value in fields.items():
        sets.append(f"{key} = %s")
        values.append(json.dumps(value) if key == "result" else value)
    if steps:
        sets.append("steps = steps || %s::jsonb")
        values.append(json.dumps([steps]))
    with conn.cursor() as cur:
        cur.execute(f"update relay_job set {', '.join(sets)} where id = %s", (*values, job_id))
    conn.commit()


def last_json_object(text: str, key: str = "body") -> dict | None:
    """The agent's final JSON object holding key (it may print notes before it)."""
    for match in reversed(list(re.finditer(r"\{", text))):
        try:
            value, _ = json.JSONDecoder().raw_decode(text[match.start():])
        except ValueError:
            continue
        if isinstance(value, dict) and key in value:
            return value
    return None


def main(job_id: str) -> int:
    if not re.fullmatch(r"[0-9a-f-]{36}", job_id):
        return 2
    conn = psycopg2.connect(DSN)
    with conn.cursor() as cur:
        cur.execute("update relay_job set status = 'running', started_at = now(), steps = steps || %s::jsonb "
                    "where id = %s and status = 'queued' returning id, note", (json.dumps(["Agent started: reading the thread and the CRM"]), job_id))
        claimed = cur.fetchone()
    conn.commit()
    if not claimed:
        return 0
    # "Create deal" and "Update deal from this reply" are Matcha's CRM work; every other job is a reply Mailvin drafts.
    deal = (claimed[1] or "").startswith("[deal:")
    folder = JOB_ROOT / job_id
    prompt = folder / "prompt.txt"
    try:
        result = subprocess.run(
            ["hermes", "-p", "matcha" if deal else "mailvin", "chat", "-Q", "--oneshot", "--source", "relay-job",
             "--run-budget", str(BUDGET_SECONDS), "--query-file", str(prompt)],
            cwd=folder, text=True, capture_output=True, timeout=BUDGET_SECONDS + 120, check=False)
        (folder / "agent-output.txt").write_text((result.stdout or "") + "\n--- stderr ---\n" + (result.stderr or "")[-4000:])
        parsed = last_json_object(result.stdout or "", "action" if deal else "body")
        session = re.search(r"session_id:\s*(\S+)", (result.stdout or "") + (result.stderr or ""))
        if deal:
            if not parsed or parsed.get("action") not in ("created", "updated", "none"):
                update(conn, job_id, status="failed", error="Matcha finished without a result. Try again, or ask Matcha directly.",
                       session_id=session.group(1) if session else None)
                return 1
            update(conn, job_id, status="ready", result=parsed, session_id=session.group(1) if session else None, step="Matcha finished")
            return 0
        if not parsed or not str(parsed.get("body") or "").strip():
            update(conn, job_id, status="failed", error="The agent finished without a draft. Try again, or use a quick draft.",
                   session_id=session.group(1) if session else None)
            return 1
        made = [f.name for f in folder.iterdir() if f.is_file() and f.suffix.lower() in (".xlsx", ".csv", ".pdf", ".docx")]
        update(conn, job_id, status="ready", result=parsed, session_id=session.group(1) if session else None,
               step=f"Agent finished{(': made ' + ', '.join(made)) if made else ''}")
        return 0
    except subprocess.TimeoutExpired:
        update(conn, job_id, status="failed", error="The agent ran out of time (15 minutes).")
        return 1
    except Exception as exc:  # noqa: BLE001 - any failure must reach the page, not vanish
        update(conn, job_id, status="failed", error=f"Runner error: {str(exc)[:200]}")
        return 1
    finally:
        with conn.cursor() as cur:
            cur.execute("update relay_job set finished_at = coalesce(finished_at, now()) where id = %s and status = 'failed'", (job_id,))
        conn.commit()
        conn.close()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else ""))
