#!/usr/bin/env python3
"""Relay desk runner: one turn of an email's own Claude Code session.

Started detached by the CRM (lib/relay-desk.ts startDesk) as: relay_desk.py <run id>
It claims the queued relay_desk_run, fetches the turn's brief from the CRM (/api/relay/internal/desk/brief), and runs
Alex's Claude Code (config /root/.claude-alex, cwd /root/.hermes, Opus 5.5) on it: resuming the email's session
(relay_item.desk_session_id) or starting it. The session gets Relay's MCP tools (relay_desk_mcp.py) and a short explicit
allowlist of read-only tools; anything else is refused, never prompted. As it works, each tool use becomes one quiet
trace line in relay_talk; its final words become Relay's turn. A run marked 'stopping' is killed within about two seconds.

This runner writes only relay_desk_run, relay_talk and relay_item.desk_session_id. Drafts change only through the MCP
tools, which go through the CRM's guarded code. Nothing here sends or creates a Gmail draft.

Dry run (no database writes, a throwaway session, the write tools say what they would do):
  relay_desk.py --dry-run --item <relay item id> --mode quick [--text "..."] [--as-of ISO]
  --as-of replays the email as it stood then (the technical test set): the brief and every tool see only what had arrived.
"""
from __future__ import annotations

import argparse
import json
import os
import queue
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Callable, Iterable

DSN = os.environ.get("RELAY_DSN", "host=/var/run/postgresql dbname=denchclaw")
CLAUDE = os.environ.get("RELAY_DESK_CLAUDE", "/root/.local/bin/claude")
CONFIG_DIR = "/root/.claude-alex"
WORKDIR = "/root/.hermes"
SESSIONS_DIR = Path(CONFIG_DIR) / "projects" / "-root--hermes"
MEMORY_DIR = SESSIONS_DIR / "memory"
MODEL = "claude-opus-5-5"
CRM_URL = os.environ.get("RELAY_CRM_URL", "http://127.0.0.1:3100").rstrip("/")
SECRET_FILE = os.environ.get("RELAY_INTERNAL_SECRET_FILE", "/root/.hermes/workspace/secrets/relay-internal.secret")
MCP_SERVER = str(Path(__file__).resolve().with_name("relay_desk_mcp.py"))

MODE_EFFORT = {"quick": "low", "ahead": "medium", "chat": "high"}
# Seconds; lib/relay-desk-core.ts MODE_TIMEOUT holds the same numbers.
MODE_TIMEOUT = {"quick": 180, "ahead": 360, "chat": 660}
# A ceiling on spend per turn, well above a normal turn (about $0.30 to $1), so a runaway loop stops.
MODE_BUDGET_USD = {"quick": 2, "ahead": 3, "chat": 5}
STOP_GRACE = 1.0

# The built-in tools the session has at all: everything else (Bash, Write, Edit, WebFetch, Agent...) doesn't exist for it.
BUILTIN_TOOLS = ["Read", "Grep", "Glob", "WebSearch", "Skill", "ToolSearch"]
# Paths the file tools may read. Read rules also govern Grep and Glob.
READ_ROOTS = [f"{WORKDIR}/knowledgebase", f"{WORKDIR}/skills", f"{WORKDIR}/projects/rebattery-platform", f"{WORKDIR}/workspace/invoices", str(MEMORY_DIR)]
GMAIL_READ = ["search_threads", "get_thread", "get_message", "list_drafts", "get_draft"]
GRANOLA = ["search_meetings", "get_meetings", "search_transcripts", "get_meeting_transcript", "query_granola_meetings", "list_meetings"]
ALLOWED_TOOLS = (
    ["mcp__relay"]
    + [f"mcp__claude_ai_Gmail__{t}" for t in GMAIL_READ]
    + [f"mcp__claude_ai_Granola__{t}" for t in GRANOLA]
    + ["WebSearch", "Skill", "ToolSearch"]
    + [f"Read(/{p}/**)" for p in READ_ROOTS]  # "//" marks an absolute path in a permission rule
)
GMAIL_WRITES = ["create_draft", "update_draft", "delete_draft", "send_message", "reply", "forward", "trash_message", "trash_thread", "untrash_message",
                "untrash_thread", "label_message", "label_thread", "unlabel_message", "unlabel_thread", "update_message_labels", "create_label",
                "update_label", "delete_label", "mark_message_spam", "mark_thread_spam", "unmark_message_spam", "unmark_thread_spam",
                "apply_sensitive_message_label", "apply_sensitive_thread_label"]
# Refused outright, belt and braces: dontAsk already refuses anything not allowed, and these servers can write.
DISALLOWED_TOOLS = (
    ["Bash", "Write", "Edit", "NotebookEdit", "WebFetch", "Agent", "Task"]
    + [f"mcp__claude_ai_Gmail__{t}" for t in GMAIL_WRITES]
    + ["mcp__claude_ai_Supabase", "mcp__claude_ai_Google_Drive", "mcp__claude_ai_Google_Calendar", "mcp__claude_ai_Linear", "mcp__claude_ai_Notion", "mcp__claude_ai_Claude_Docs"]
)


def read_denies(root: str = WORKDIR) -> list[str]:
    """Deny rules for everything under the working directory outside READ_ROOTS. Claude Code lets a session read its own
    working directory without asking, so the rest of /root/.hermes (secrets, profiles, state) is shut off by name."""
    keep = {Path(p) for p in READ_ROOTS}
    denies: list[str] = []

    def walk(directory: Path) -> None:
        try:
            children = sorted(directory.iterdir())
        except OSError:
            return
        for child in children:
            if child in keep:
                continue
            if any(k.is_relative_to(child) for k in keep) and child.is_dir() and not child.is_symlink():
                walk(child)
                continue
            # A space or comma would split the rule list, so any odd character becomes a wildcard.
            safe = re.sub(r"[^A-Za-z0-9._@+/-]", "*", str(child))
            denies.append(f"Read(/{safe})")
            if child.is_dir():
                denies.append(f"Read(/{safe}/**)")

    walk(Path(root))
    return denies


def mcp_config(item: str, run: str, dry_run: bool, crm_url: str = CRM_URL, server: str = MCP_SERVER) -> dict:
    """The --mcp-config for one run: Relay's stdio server, told which email and run it acts for."""
    env = {"RELAY_DESK_ITEM": item, "RELAY_DESK_RUN": run, "RELAY_CRM_URL": crm_url, "RELAY_INTERNAL_SECRET_FILE": SECRET_FILE}
    if dry_run:
        env["RELAY_DESK_DRY_RUN"] = "1"
    return {"mcpServers": {"relay": {"type": "stdio", "command": "/usr/bin/python3", "args": ["-I", server], "env": env}}}


def session_args(session_id: str, sessions_dir: Path = SESSIONS_DIR) -> list[str]:
    """Resume the email's session when Claude Code has it on disk; otherwise start it under that id (a first turn, or one
    that failed before the session was saved)."""
    return ["--resume", session_id] if (sessions_dir / f"{session_id}.jsonl").exists() else ["--session-id", session_id]


def build_command(mode: str, session: list[str], brief_file: str, mcp_file: str, denies: Iterable[str], dry_run: bool = False, claude: str = CLAUDE) -> list[str]:
    """The claude command for one turn. The prompt goes on stdin, so email text is never on the command line."""
    if mode not in MODE_EFFORT:
        raise ValueError(f"unknown mode {mode!r}")
    command = [
        claude, "-p",
        "--model", MODEL, "--effort", MODE_EFFORT[mode],
        *session,
        "--append-system-prompt-file", brief_file,
        # The brief is rebuilt every turn; without this a resumed session would keep the first turn's brief.
        "--system-prompt-snapshot", "off",
        "--mcp-config", mcp_file,
        "--tools", ",".join(BUILTIN_TOOLS),
        "--allowedTools", ",".join(ALLOWED_TOOLS),
        "--disallowedTools", ",".join([*DISALLOWED_TOOLS, *denies]),
        "--permission-mode", "dontAsk", "--permission-prompts", "none",
        # Only Alex's user settings: the project's local allow rules (Bash and friends) must not reach the desk.
        "--setting-sources", "user",
        "--max-budget-usd", str(MODE_BUDGET_USD[mode]),
        "--output-format", "stream-json", "--verbose",
    ]
    if dry_run:
        command.append("--no-session-persistence")
    return command


def claude_env(base: dict[str, str] | None = None) -> dict[str, str]:
    """Alex's Claude Code on his plan: his config dir, and no API key or parent session leaking in from the CRM."""
    env = dict(os.environ if base is None else base)
    for key in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT"):
        env.pop(key, None)
    env["CLAUDE_CONFIG_DIR"] = CONFIG_DIR
    return env


# ---------- what the session did, in plain words ----------

def _short(value: Any, limit: int = 60) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _mail_query(query: str) -> str:
    """A Gmail search as words: from:mathieu@x.fr subject:LFP -> mathieu@x.fr LFP."""
    return _short(re.sub(r"\b(from|to|cc|subject|in|label|after|before|newer_than|older_than|is|has):", "", query or ""), 50)


def trace_line(name: str, args: dict | None) -> str | None:
    """One tool use as a quiet line for Relay's chat, British English, plain and short. None: not worth a line."""
    a = args if isinstance(args, dict) else {}
    tool = name.split("__")[-1] if name.startswith("mcp__") else name
    server = name.split("__")[1] if name.startswith("mcp__") and name.count("__") >= 2 else ""
    if server == "relay":
        lines: dict[str, Callable[[], str | None]] = {
            "relay_state": lambda: "Read the email and its drafts",
            "relay_write_reply": lambda: "Wrote the reply",
            "relay_update_draft": lambda: "Updated the draft" if a.get("body") else "Changed who the draft goes to" if any(a.get(k) for k in ("to", "cc", "bcc")) else "Updated the draft",
            "relay_add_email": lambda: (f"Wrote to {_short(a.get('to'), 40)} on their own thread" if a.get("reply_on") else f"Added an email to {_short(a.get('to'), 40)}") if a.get("to") else "Added a linked email",
            "relay_threads": lambda: f"Looked for your threads with {_short(a.get('person'), 40)}" if a.get("person") else "Looked for your threads",
            "relay_set_price": lambda: "Set a price",
            "relay_reprice": lambda: "Worked the prices out again",
            "relay_add_todo": lambda: f"Suggested a to-do: {_short(a.get('title'), 50)}",
            "relay_remember_lesson": lambda: "Added a lesson to your email-writing lessons",
            "relay_ask": lambda: None,  # the question itself shows in the chat
            "relay_propose_listings": lambda: "Proposed draft listings for you to approve",
            "crm_query": lambda: "Looked in the CRM",
            "marketplace_account": lambda: f"Checked {_short(a.get('email'), 40)} on the marketplace" if a.get("email") else "Checked the marketplace",
            "marketplace_listings": lambda: f"Searched the marketplace for {_short(a.get('query'), 40)}" if a.get("query") else "Looked at the marketplace listings",
            "marketplace_deal": lambda: "Read a marketplace deal",
            "attachment_text": lambda: "Read the attachments",
            "penny_price": lambda: f"Checked Penny's price for {_short(a.get('battery'), 40)}",
        }
        return lines[tool]() if tool in lines else None
    if server == "claude_ai_Gmail":
        if tool == "search_threads":
            q = _mail_query(str(a.get("query") or ""))
            return f"Searched your mail for {q}" if q else "Searched your mail"
        return {"get_thread": "Read an email thread", "get_message": "Read an email", "list_drafts": "Looked at your Gmail drafts",
                "get_draft": "Read a Gmail draft"}.get(tool)
    if server == "claude_ai_Granola":
        q = _short(a.get("query") or a.get("keywords") or a.get("participant"), 40)
        if tool in ("search_meetings", "search_transcripts", "query_granola_meetings"):
            return f"Searched your Granola calls for {q}" if q else "Searched your Granola calls"
        return {"get_meetings": "Read the Granola notes", "get_meeting_transcript": "Read a Granola transcript", "list_meetings": "Looked through your Granola calls"}.get(tool)
    if tool == "WebSearch":
        return f"Searched the web for {_short(a.get('query'), 50)}"
    if tool == "Read":
        return f"Read {_short(Path(str(a.get('file_path') or '')).name, 50)}" if a.get("file_path") else "Read a file"
    if tool in ("Grep", "Glob"):
        q = _short(a.get("pattern"), 40)
        return f"Searched the knowledge base for {q}" if q else "Searched the knowledge base"
    if tool == "Skill":
        return f"Used the {_short(a.get('skill') or a.get('name'), 40)} skill"
    return None  # ToolSearch and anything else is plumbing


def parse_event(line: str) -> list[dict]:
    """One stream-json line as the events the runner acts on: init (model, session), tool (id, name, input),
    tool_done (id, error, text), result (text, cost, session, error). Anything else, or a broken line, is nothing."""
    try:
        event = json.loads(line)
    except ValueError:
        return []
    if not isinstance(event, dict):
        return []
    kind = event.get("type")
    if kind == "system" and event.get("subtype") == "init":
        return [{"kind": "init", "model": event.get("model"), "session": event.get("session_id"), "tools": event.get("tools") or []}]
    content = (event.get("message") or {}).get("content") if isinstance(event.get("message"), dict) else None
    if kind == "assistant" and isinstance(content, list):
        return [{"kind": "tool", "id": c.get("id"), "name": str(c.get("name") or ""), "input": c.get("input") if isinstance(c.get("input"), dict) else {}}
                for c in content if isinstance(c, dict) and c.get("type") == "tool_use"]
    if kind == "user" and isinstance(content, list):
        out = []
        for c in content:
            if isinstance(c, dict) and c.get("type") == "tool_result":
                body = c.get("content")
                text = body if isinstance(body, str) else " ".join(p.get("text", "") for p in body if isinstance(p, dict)) if isinstance(body, list) else ""
                out.append({"kind": "tool_done", "id": c.get("tool_use_id"), "error": bool(c.get("is_error")), "text": _short(text, 200)})
        return out
    if kind == "result":
        return [{"kind": "result", "text": str(event.get("result") or "").strip(), "cost": event.get("total_cost_usd"), "session": event.get("session_id"),
                 "error": bool(event.get("is_error")) or event.get("subtype") not in (None, "success"), "subtype": event.get("subtype")}]
    return []


def refusal_line(name: str, text: str) -> str | None:
    """A refused Relay change, as a trace line, so Alex sees why a draft didn't change. Other tools' errors stay quiet."""
    if not name.startswith("mcp__relay__") or name.endswith(("relay_state", "crm_query")):
        return None
    return f"Not saved: {_short(text, 160)}"


# ---------- running claude ----------

def run_claude(command: list[str], prompt: str, timeout: float, on_line: Callable[[str], None], should_stop: Callable[[], bool],
               env: dict[str, str] | None = None, cwd: str = WORKDIR, poll: float = 0.5, stderr_path: str | None = None) -> dict:
    """Runs the command in its own process group, feeding each stdout line to on_line as it comes. Stops it (the whole
    group) when should_stop() says so or the time is up. Returns {outcome: done|timeout|stopped, code, stderr}."""
    stderr_file = open(stderr_path, "w+b") if stderr_path else tempfile.TemporaryFile()
    proc = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr_file, cwd=cwd, env=env, start_new_session=True)
    lines: queue.Queue[str | None] = queue.Queue()

    def pump() -> None:
        assert proc.stdout is not None
        for raw in proc.stdout:
            lines.put(raw.decode("utf-8", "replace"))
        lines.put(None)

    reader = threading.Thread(target=pump, daemon=True)
    reader.start()
    try:
        assert proc.stdin is not None
        proc.stdin.write(prompt.encode())
        proc.stdin.close()
    except BrokenPipeError:
        pass
    deadline = time.monotonic() + timeout
    outcome, next_check, ended = "done", 0.0, False
    while not ended:
        try:
            line = lines.get(timeout=poll)
            if line is None:
                ended = True
            else:
                on_line(line)
            continue
        except queue.Empty:
            pass
        finally:
            now = time.monotonic()
            if not ended and now >= deadline:
                outcome, ended = "timeout", True
            elif not ended and now >= next_check:
                next_check = now + 1.0
                if should_stop():
                    outcome, ended = "stopped", True
    if outcome != "done":
        kill_group(proc)
    code = proc.wait()
    reader.join(timeout=2)
    stderr_file.seek(0)
    stderr = stderr_file.read().decode("utf-8", "replace")[-4000:]
    stderr_file.close()
    return {"outcome": outcome, "code": code, "stderr": stderr}


def kill_group(proc: subprocess.Popen) -> None:
    """TERM to the whole process group (claude and its MCP servers), KILL after STOP_GRACE."""
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(proc.pid, sig)
        except ProcessLookupError:
            return
        try:
            proc.wait(timeout=STOP_GRACE)
            return
        except subprocess.TimeoutExpired:
            continue


def fetch_brief(item: str, mode: str, text: str, run: str | None = None, as_of: str | None = None) -> dict:
    with open(SECRET_FILE, encoding="utf-8") as handle:
        secret = handle.read().strip()
    request = urllib.request.Request(f"{CRM_URL}/api/relay/internal/desk/brief", data=json.dumps({"item": item, "mode": mode, "text": text, "run": run, **({"as_of": as_of, "dry_run": True} if as_of else {})}).encode(),
                                     method="POST", headers={"content-type": "application/json", "authorization": f"Bearer {secret}"})
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            answer = json.loads(response.read())
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"The CRM refused the brief ({error.code}): {error.read()[:200].decode('utf-8', 'replace')}") from None
    if not isinstance(answer.get("brief"), str) or not isinstance(answer.get("prompt"), str) or not answer["prompt"].strip():
        raise RuntimeError("The CRM's brief was incomplete.")
    return answer


class Turn:
    """What one turn did, gathered from the stream: a line for each tool as its answer comes back (so a refused read or a
    refused change never reads as done), then the result."""

    def __init__(self, emit_trace: Callable[[str, str], None]):
        self.emit_trace = emit_trace
        self.uses: dict[str, tuple[str, dict]] = {}
        self.model: str | None = None
        self.session: str | None = None
        self.result: dict | None = None
        self.tools: list[str] = []

    def on_line(self, line: str) -> None:
        for event in parse_event(line):
            if event["kind"] == "init":
                self.model, self.session = event["model"], event["session"]
            elif event["kind"] == "tool":
                self.uses[event["id"]] = (event["name"], event["input"])
                self.tools.append(event["name"])
            elif event["kind"] == "tool_done":
                name, args = self.uses.pop(event["id"], ("", {}))
                said = refusal_line(name, event["text"]) if event["error"] else trace_line(name, args)
                if said:
                    self.emit_trace(said, name)
            elif event["kind"] == "result":
                self.result = event
                self.session = event["session"] or self.session


# ---------- the run ----------

def dry_run(item: str, mode: str, text: str, as_of: str | None = None) -> int:
    """A turn with no database writes and a throwaway session: prints what the desk did and would do."""
    brief = fetch_brief(item, mode, text, as_of=as_of)
    folder = tempfile.mkdtemp(prefix="relay-desk-dry-")
    try:
        brief_file, mcp_file = os.path.join(folder, "brief.md"), os.path.join(folder, "mcp.json")
        Path(brief_file).write_text(brief["brief"])
        config = mcp_config(item, "", True)
        if as_of:
            config["mcpServers"]["relay"]["env"]["RELAY_DESK_AS_OF"] = as_of
        Path(mcp_file).write_text(json.dumps(config))
        command = build_command(mode, ["--session-id", str(uuid.uuid4())], brief_file, mcp_file, read_denies(), dry_run=True)
        started = time.monotonic()
        turn = Turn(lambda said, name: print(f"[trace] {said}    ({name})", flush=True))
        raw_log = open(os.path.join(folder, "stream.jsonl"), "w")

        def on_line(line: str) -> None:
            raw_log.write(line)
            turn.on_line(line)

        outcome = run_claude(command, brief["prompt"], MODE_TIMEOUT[mode], on_line, lambda: False, env=claude_env())
        raw_log.close()
        print(f"[relay] {turn.result['text'] if turn.result else '(no final answer)'}", flush=True)
        print(json.dumps({"outcome": outcome["outcome"], "code": outcome["code"], "model": turn.model, "session": turn.session,
                          "cost_usd": turn.result and turn.result.get("cost"), "seconds": round(time.monotonic() - started), "tools": turn.tools,
                          "error": turn.result and turn.result.get("error"), "stderr": outcome["stderr"][-500:] or None, "stream": os.path.join(folder, "stream.jsonl")}))
        return 0 if outcome["outcome"] == "done" and turn.result and not turn.result["error"] else 1
    finally:
        if os.environ.get("RELAY_DESK_KEEP") != "1":
            shutil.rmtree(folder, ignore_errors=True)


TRACE_READ = {"line": "", "items": []}


def main_run(run_id: str) -> int:
    import psycopg2  # only a real run needs the database

    conn = psycopg2.connect(DSN)
    conn.autocommit = True
    with conn.cursor() as cur:
        cur.execute("update relay_desk_run set status = 'running', started_at = now(), pid = %s where id = %s and status = 'queued' "
                    "returning item_id, owner_id::text, mode, text", (os.getpid(), run_id))
        claimed = cur.fetchone()
    if not claimed:
        conn.close()
        return 0
    item, owner, mode, text = claimed
    started = time.monotonic()

    def say(role: str, words: str, applied: dict | None) -> None:
        with conn.cursor() as cur:
            cur.execute("insert into relay_talk (item_id, owner_id, role, text, target, applied) values (%s, %s::uuid, %s, %s, 'all', %s::jsonb)",
                        (item, owner, role, words[:4000], json.dumps(applied) if applied is not None else None))

    def trace(words: str, tool: str, failed: bool = False) -> None:
        applied = {"ms": int((time.monotonic() - started) * 1000), "read": TRACE_READ, "notes": [], "desk": {"tool": tool, "run": run_id}}
        if failed:
            applied["failed"] = True
        say("trace", words, applied)

    def finish(status: str, error: str | None = None, cost: Any = None, session: str | None = None) -> None:
        with conn.cursor() as cur:
            cur.execute("update relay_desk_run set status = %s, error = %s, cost_usd = %s, session_id = coalesce(%s, session_id), finished_at = now() where id = %s",
                        (status, error, cost, session, run_id))

    def stopping() -> bool:
        with conn.cursor() as cur:
            cur.execute("select status from relay_desk_run where id = %s", (run_id,))
            row = cur.fetchone()
        return not row or row[0] == "stopping"

    folder = tempfile.mkdtemp(prefix=f"relay-desk-{run_id}-")
    try:
        with conn.cursor() as cur:
            cur.execute("update relay_item set desk_session_id = coalesce(desk_session_id, %s) where id = %s returning desk_session_id", (str(uuid.uuid4()), item))
            session_id = cur.fetchone()[0]
        brief = fetch_brief(item, mode, text, run_id)
        brief_file, mcp_file = os.path.join(folder, "brief.md"), os.path.join(folder, "mcp.json")
        Path(brief_file).write_text(brief["brief"])
        Path(mcp_file).write_text(json.dumps(mcp_config(item, run_id, False)))
        command = build_command(mode, session_args(session_id), brief_file, mcp_file, read_denies())
        turn = Turn(trace)
        outcome = run_claude(command, brief["prompt"], MODE_TIMEOUT[mode], turn.on_line, stopping, env=claude_env())
        result = turn.result or {}
        cost = result.get("cost")
        if outcome["outcome"] == "stopped":
            trace("Stopped.", "stop")
            finish("stopped", None, cost, turn.session)
            return 0
        if outcome["outcome"] == "timeout":
            say("relay", f"I ran out of time ({MODE_TIMEOUT[mode] // 60} minutes) before finishing. Anything I changed is in the drafts, with Undo; ask again to carry on.", None)
            finish("failed", "Ran out of time", cost, turn.session)
            return 1
        if not turn.result or result.get("error"):
            why = result.get("text") or (outcome["stderr"].strip().splitlines() or ["The desk stopped without an answer."])[-1]
            trace("Something went wrong. Try again.", "error", failed=True)
            finish("failed", _short(why, 300), cost, turn.session)
            return 1
        if result["text"]:
            say("relay", result["text"], None)
        finish("done", None, cost, turn.session)
        return 0
    except Exception as exc:  # noqa: BLE001 - any failure must reach the page, not vanish
        trace("Relay's desk couldn't run. Try again.", "error", failed=True)
        finish("failed", f"Runner error: {str(exc)[:200]}")
        return 1
    finally:
        shutil.rmtree(folder, ignore_errors=True)
        conn.close()


def main(argv: list[str]) -> int:
    if argv and argv[0] == "--dry-run":
        parser = argparse.ArgumentParser(prog="relay_desk.py --dry-run")
        parser.add_argument("--item", required=True)
        parser.add_argument("--mode", choices=sorted(MODE_EFFORT), default="quick")
        parser.add_argument("--text", default="")
        parser.add_argument("--as-of", default=None)
        args = parser.parse_args(argv[1:])
        return dry_run(args.item, args.mode, args.text, args.as_of)
    run_id = argv[0] if argv else ""
    if not re.fullmatch(r"[0-9a-f-]{36}", run_id):
        return 2
    return main_run(run_id)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
