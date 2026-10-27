#!/usr/bin/env python3
"""Relay agent job runner: runs the mail agent on one queued job and stores its JSON result.

Started detached by the CRM (lib/relay.ts startJob) as: relay_job.py <job id>
The prompt is in /srv/rebattery-data/relay-jobs/<id>/prompt.txt. The agent may read the CRM and build files in that
folder; it never writes mail or data. This runner only updates relay_job. The CRM turns a 'ready' job into drafts.
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


def last_json_object(text: str) -> dict | None:
    """The agent's final JSON object (it may print notes before it)."""
    for match in reversed(list(re.finditer(r"\{", text))):
        try:
            value, _ = json.JSONDecoder().raw_decode(text[match.start():])
        except ValueError:
            continue
        if isinstance(value, dict) and "body" in value:
            return value
    return None


def main(job_id: str) -> int:
    if not re.fullmatch(r"[0-9a-f-]{36}", job_id):
        return 2
    conn = psycopg2.connect(DSN)
    with conn.cursor() as cur:
        cur.execute("update relay_job set status = 'running', started_at = now(), steps = steps || %s::jsonb "
                    "where id = %s and status = 'queued' returning id", (json.dumps(["Agent started: reading the thread and the CRM"]), job_id))
        claimed = cur.fetchone()
    conn.commit()
    if not claimed:
        return 0
    folder = JOB_ROOT / job_id
    prompt = folder / "prompt.txt"
    try:
        result = subprocess.run(
            ["hermes", "-p", "mailvin", "chat", "-Q", "--oneshot", "--source", "relay-job",
             "--run-budget", str(BUDGET_SECONDS), "--query-file", str(prompt)],
            cwd=folder, text=True, capture_output=True, timeout=BUDGET_SECONDS + 120, check=False)
        (folder / "agent-output.txt").write_text((result.stdout or "") + "\n--- stderr ---\n" + (result.stderr or "")[-4000:])
        parsed = last_json_object(result.stdout or "")
        session = re.search(r"session_id:\s*(\S+)", (result.stdout or "") + (result.stderr or ""))
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
