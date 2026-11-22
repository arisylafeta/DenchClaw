import json
import os
import stat
import sys
import textwrap
import time
from pathlib import Path

import pytest

import relay_desk as rd


# ---------- the command ----------

def test_command_for_a_first_turn_and_a_resumed_one(tmp_path):
    assert rd.session_args("abc", tmp_path) == ["--session-id", "abc"]
    (tmp_path / "abc.jsonl").write_text("{}")
    assert rd.session_args("abc", tmp_path) == ["--resume", "abc"]
    cmd = rd.build_command("chat", ["--resume", "abc"], "/t/brief.md", "/t/mcp.json", ["Read(//root/.hermes/workspace/secrets/**)"], claude="claude")
    flag = lambda name: cmd[cmd.index(name) + 1]  # noqa: E731
    assert cmd[:2] == ["claude", "-p"]
    assert flag("--model") == "claude-opus-5-5" and flag("--effort") == "high" and flag("--resume") == "abc"
    assert flag("--append-system-prompt-file") == "/t/brief.md" and flag("--mcp-config") == "/t/mcp.json"
    assert flag("--permission-mode") == "dontAsk" and flag("--permission-prompts") == "none"
    assert flag("--output-format") == "stream-json" and "--verbose" in cmd
    assert flag("--system-prompt-snapshot") == "off" and flag("--setting-sources") == "user"
    assert flag("--tools") == "Read,Grep,Glob,WebSearch,Skill,ToolSearch"
    assert "Read(//root/.hermes/workspace/secrets/**)" in flag("--disallowedTools").split(",")
    assert "--no-session-persistence" not in cmd
    # The prompt goes on stdin: nothing after -p is free text.
    assert all(a.startswith("-") or cmd[i - 1].startswith("-") for i, a in enumerate(cmd[2:], start=2))


def test_each_mode_has_its_effort_time_and_budget():
    for mode, effort in (("quick", "low"), ("ahead", "medium"), ("chat", "high")):
        cmd = rd.build_command(mode, ["--session-id", "x"], "b", "m", [], claude="claude")
        assert cmd[cmd.index("--effort") + 1] == effort
    assert rd.MODE_TIMEOUT == {"quick": 180, "ahead": 360, "chat": 660}
    assert "--no-session-persistence" in rd.build_command("quick", ["--session-id", "x"], "b", "m", [], dry_run=True, claude="claude")
    with pytest.raises(ValueError):
        rd.build_command("sing", [], "b", "m", [])


def test_the_allowlist_is_read_only():
    allowed = rd.ALLOWED_TOOLS
    assert "mcp__relay" in allowed
    assert {f"mcp__claude_ai_Gmail__{t}" for t in ("search_threads", "get_thread", "get_message", "list_drafts", "get_draft")} <= set(allowed)
    assert not any(t.startswith("mcp__claude_ai_Gmail__") and t.split("__")[-1] in rd.GMAIL_WRITES for t in allowed)
    assert {f"mcp__claude_ai_Granola__{t}" for t in rd.GRANOLA} <= set(allowed)
    for banned in ("Bash", "Write", "Edit", "WebFetch", "Agent", "Task", "mcp__claude_ai_Supabase"):
        assert banned not in allowed and banned in rd.DISALLOWED_TOOLS
    assert "mcp__claude_ai_Gmail__send_message" in rd.DISALLOWED_TOOLS and "mcp__claude_ai_Gmail__create_draft" in rd.DISALLOWED_TOOLS
    reads = [t for t in allowed if t.startswith("Read(")]
    assert reads == ["Read(//root/.hermes/knowledgebase/**)", "Read(//root/.hermes/skills/**)", "Read(//root/.hermes/projects/rebattery-platform/**)",
                     "Read(//root/.hermes/workspace/invoices/**)", "Read(//root/.claude-alex/projects/-root--hermes/memory/**)"]
    assert not set(rd.BUILTIN_TOOLS) & {"Bash", "Write", "Edit", "WebFetch", "Agent", "Task", "NotebookEdit"}


def test_read_denies_shut_everything_but_the_allowed_folders(tmp_path, monkeypatch):
    for d in ("knowledgebase/a", "skills", "projects/rebattery-platform", "projects/other", "workspace/invoices", "workspace/secrets", "profiles"):
        (tmp_path / d).mkdir(parents=True)
    (tmp_path / ".env").write_text("x")
    (tmp_path / "workspace" / "odd name, here").mkdir()
    monkeypatch.setattr(rd, "READ_ROOTS", [str(tmp_path / p) for p in ("knowledgebase", "skills", "projects/rebattery-platform", "workspace/invoices")])
    denies = rd.read_denies(str(tmp_path))
    root = f"/{tmp_path}"
    assert f"Read({root}/.env)" in denies
    assert f"Read({root}/profiles/**)" in denies and f"Read({root}/workspace/secrets/**)" in denies and f"Read({root}/projects/other/**)" in denies
    assert f"Read({root}/workspace/odd*name**here/**)" in denies
    assert not any(x in d for d in denies for x in ("knowledgebase", "/skills", "rebattery-platform", "invoices"))
    assert f"Read({root}/projects)" not in denies and f"Read({root}/workspace)" not in denies


def test_mcp_config_names_the_item_and_run_and_the_dry_run():
    cfg = rd.mcp_config("item-1", "run-1", True, crm_url="http://crm", server="/s/relay_desk_mcp.py")["mcpServers"]["relay"]
    assert cfg["command"] == "/usr/bin/python3" and cfg["args"] == ["-I", "/s/relay_desk_mcp.py"]
    assert cfg["env"]["RELAY_DESK_ITEM"] == "item-1" and cfg["env"]["RELAY_DESK_RUN"] == "run-1" and cfg["env"]["RELAY_DESK_DRY_RUN"] == "1"
    assert "RELAY_DESK_DRY_RUN" not in rd.mcp_config("i", "r", False)["mcpServers"]["relay"]["env"]
    assert not any("secret" in v.lower() and not v.endswith(".secret") for v in cfg["env"].values())


def test_claude_env_uses_alexs_config_and_drops_api_keys():
    env = rd.claude_env({"PATH": "/bin", "ANTHROPIC_API_KEY": "k", "CLAUDECODE": "1"})
    assert env == {"PATH": "/bin", "CLAUDE_CONFIG_DIR": "/root/.claude-alex"}


# ---------- the stream ----------

def line(obj):
    return json.dumps(obj) + "\n"


def test_parse_event_reads_init_tools_errors_and_result():
    assert rd.parse_event(line({"type": "system", "subtype": "init", "model": "claude-opus-5-5", "session_id": "s1", "tools": ["Read"]})) == [
        {"kind": "init", "model": "claude-opus-5-5", "session": "s1", "tools": ["Read"]}]
    tools = rd.parse_event(line({"type": "assistant", "message": {"content": [{"type": "text", "text": "Looking"},
                                 {"type": "tool_use", "id": "t1", "name": "mcp__relay__crm_query", "input": {"sql": "select 1"}}]}}))
    assert tools == [{"kind": "tool", "id": "t1", "name": "mcp__relay__crm_query", "input": {"sql": "select 1"}}]
    err = rd.parse_event(line({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t1", "is_error": True, "content": [{"type": "text", "text": "leak"}]}]}}))
    assert err == [{"kind": "tool_done", "id": "t1", "error": True, "text": "leak"}]
    assert rd.parse_event(line({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t1", "content": "fine"}]}})) == [
        {"kind": "tool_done", "id": "t1", "error": False, "text": "fine"}]
    assert rd.parse_event(line({"type": "user", "message": {"content": "plain text"}})) == []
    res = rd.parse_event(line({"type": "result", "subtype": "success", "is_error": False, "result": " Done. ", "total_cost_usd": 0.41, "session_id": "s1"}))
    assert res == [{"kind": "result", "text": "Done.", "cost": 0.41, "session": "s1", "error": False, "subtype": "success"}]
    assert rd.parse_event(line({"type": "result", "subtype": "error_max_turns", "is_error": False}))[0]["error"] is True
    assert rd.parse_event("not json") == [] and rd.parse_event("[1]") == [] and rd.parse_event(line({"type": "stream_event"})) == []


@pytest.mark.parametrize("name,args,said", [
    ("mcp__relay__relay_state", {}, "Read the email and its drafts"),
    ("mcp__relay__relay_write_reply", {"body": "x"}, "Wrote the reply"),
    ("mcp__relay__relay_update_draft", {"body": "x"}, "Updated the draft"),
    ("mcp__relay__relay_update_draft", {"cc": ["a@b.co"]}, "Changed who the draft goes to"),
    ("mcp__relay__relay_add_email", {"to": "roberto@parts.it"}, "Added an email to roberto@parts.it"),
    ("mcp__relay__relay_reprice", {}, "Worked the prices out again"),
    ("mcp__relay__relay_add_todo", {"title": "Send the VIN"}, "Suggested a to-do: Send the VIN"),
    ("mcp__relay__relay_ask", {"question": "?"}, None),
    ("mcp__relay__crm_query", {"sql": "select"}, "Looked in the CRM"),
    ("mcp__relay__marketplace_account", {"email": "ben@x.co.uk"}, "Checked ben@x.co.uk on the marketplace"),
    ("mcp__relay__penny_price", {"battery": "ID.3 62"}, "Checked Penny's price for ID.3 62"),
    ("mcp__relay__attachment_text", {"message_id": "m"}, "Read the attachments"),
    ("mcp__claude_ai_Gmail__search_threads", {"query": "from:mathieu@x.fr"}, "Searched your mail for mathieu@x.fr"),
    ("mcp__claude_ai_Gmail__get_thread", {"thread_id": "t"}, "Read an email thread"),
    ("mcp__claude_ai_Granola__search_meetings", {"keywords": ["Mathieu"]}, "Searched your Granola calls for ['Mathieu']"),
    ("mcp__claude_ai_Granola__get_meetings", {"meeting_ids": ["x"]}, "Read the Granola notes"),
    ("WebSearch", {"query": "VW ID.3 battery price"}, "Searched the web for VW ID.3 battery price"),
    ("Read", {"file_path": "/root/.hermes/knowledgebase/20-strategy/buyer-icp-matrix.md"}, "Read buyer-icp-matrix.md"),
    ("Grep", {"pattern": "MEB"}, "Searched the knowledge base for MEB"),
    ("Skill", {"skill": "cold-email"}, "Used the cold-email skill"),
    ("ToolSearch", {"query": "gmail"}, None),
    ("mcp__relay__unknown", {}, None),
])
def test_trace_lines_are_plain_and_short(name, args, said):
    assert rd.trace_line(name, args) == said


def test_trace_lines_trim_long_inputs():
    said = rd.trace_line("WebSearch", {"query": "x " * 100})
    assert len(said) <= len("Searched the web for ") + 50 and said.endswith("…")


def test_only_refused_relay_changes_become_lines():
    assert rd.refusal_line("mcp__relay__relay_update_draft", "It's waiting to send.") == "Not saved: It's waiting to send."
    assert rd.refusal_line("mcp__relay__crm_query", "syntax error") is None
    assert rd.refusal_line("Read", "denied") is None


def test_turn_collects_lines_session_and_result():
    said = []
    turn = rd.Turn(lambda words, tool: said.append((words, tool)))
    use = lambda i, name, args: {"type": "assistant", "message": {"content": [{"type": "tool_use", "id": i, "name": name, "input": args}]}}  # noqa: E731
    done = lambda i, error, text: {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": i, "is_error": error, "content": text}]}}  # noqa: E731
    for obj in [{"type": "system", "subtype": "init", "model": "claude-opus-5-5", "session_id": "s1"},
                use("a", "mcp__relay__relay_update_draft", {"body": "x"}), done("a", True, "The draft changed."),
                use("b", "Read", {"file_path": "/root/.hermes/AGENTS.md"}), done("b", True, "Permission denied"),
                use("c", "mcp__relay__relay_update_draft", {"body": "y"}), done("c", False, "{}"),
                {"type": "result", "subtype": "success", "result": "Shortened it.", "total_cost_usd": 0.3, "session_id": "s1"}]:
        turn.on_line(line(obj))
    # The refused change says why; the refused read says nothing; the change that went through says so.
    assert said == [("Not saved: The draft changed.", "mcp__relay__relay_update_draft"), ("Updated the draft", "mcp__relay__relay_update_draft")]
    assert turn.model == "claude-opus-5-5" and turn.session == "s1" and turn.result["text"] == "Shortened it."


# ---------- running a fake claude ----------

def fake_claude(tmp_path, body):
    script = tmp_path / "claude"
    script.write_text(f"#!{sys.executable}\n" + textwrap.dedent(body))
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    return str(script)


FAKE_OK = """
import json, sys
prompt = sys.stdin.read()
print(json.dumps({"type": "system", "subtype": "init", "model": "claude-opus-5-5", "session_id": "s-fake"}), flush=True)
print(json.dumps({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "t1", "name": "mcp__relay__relay_state", "input": {}}]}}), flush=True)
print(json.dumps({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t1", "content": "{}"}]}}), flush=True)
print(json.dumps({"type": "result", "subtype": "success", "is_error": False, "result": "Got: " + prompt, "total_cost_usd": 0.31, "session_id": "s-fake"}), flush=True)
"""


def test_run_claude_streams_lines_and_passes_the_prompt_on_stdin(tmp_path):
    claude = fake_claude(tmp_path, FAKE_OK)
    turn = rd.Turn(lambda *_: None)
    out = rd.run_claude([claude, "-p"], "--make it shorter", 10, turn.on_line, lambda: False, cwd=str(tmp_path))
    assert out["outcome"] == "done" and out["code"] == 0
    assert turn.tools == ["mcp__relay__relay_state"] and turn.result["text"] == "Got: --make it shorter" and turn.result["cost"] == 0.31


def test_run_claude_times_out_and_kills_the_whole_group(tmp_path):
    pidfile = tmp_path / "child.pid"
    claude = fake_claude(tmp_path, f"""
import subprocess, sys, time
child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
open({str(pidfile)!r}, "w").write(str(child.pid))
print('{{"type": "system", "subtype": "init", "model": "m", "session_id": "s"}}', flush=True)
time.sleep(60)
""")
    started = time.monotonic()
    out = rd.run_claude([claude], "", 1.5, lambda _l: None, lambda: False, cwd=str(tmp_path))
    assert out["outcome"] == "timeout" and time.monotonic() - started < 6
    child = int(pidfile.read_text())
    time.sleep(0.2)
    with pytest.raises(ProcessLookupError):
        os.kill(child, 0)  # the MCP-server-like child went with it


def test_run_claude_stops_within_two_seconds_when_asked(tmp_path):
    claude = fake_claude(tmp_path, "import time\ntime.sleep(60)\n")
    asked = time.monotonic() + 0.5
    started = time.monotonic()
    out = rd.run_claude([claude], "", 30, lambda _l: None, lambda: time.monotonic() > asked, cwd=str(tmp_path))
    assert out["outcome"] == "stopped" and time.monotonic() - started < 3


def test_run_claude_keeps_stderr_of_a_failed_run(tmp_path):
    claude = fake_claude(tmp_path, "import sys\nsys.stderr.write('No conversation found')\nsys.exit(1)\n")
    out = rd.run_claude([claude], "", 10, lambda _l: None, lambda: False, cwd=str(tmp_path))
    assert out == {"outcome": "done", "code": 1, "stderr": "No conversation found"}


def test_rejects_bad_run_ids():
    assert rd.main(["../../etc"]) == 2
    assert rd.main([]) == 2


# ---------- a whole run against a throwaway database (scripts/rebattery/crm-test-db.sh up) ----------

TEST_DSN = os.environ.get("RELAY_DESK_TEST_DSN")


@pytest.mark.skipif(not TEST_DSN or "127.0.0.1" not in TEST_DSN, reason="needs RELAY_DESK_TEST_DSN pointing at a throwaway database")
def test_a_run_claims_traces_answers_and_records(tmp_path, monkeypatch):
    import psycopg2

    conn = psycopg2.connect(TEST_DSN)
    conn.autocommit = True
    cur = conn.cursor()
    cur.execute("select id::text from crm_users limit 1")
    owner = cur.fetchone()[0]
    cur.execute("insert into relay_item (owner_id, gmail_thread_id, tab) values (%s, %s, 'action') returning id", (owner, f"g-{time.time()}"))
    item = cur.fetchone()[0]
    cur.execute("insert into relay_desk_run (item_id, owner_id, mode, text) values (%s, %s, 'chat', 'shorter') returning id", (item, owner))
    run = cur.fetchone()[0]
    seen = {}
    monkeypatch.setattr(rd, "DSN", TEST_DSN)
    monkeypatch.setattr(rd, "CLAUDE", fake_claude(tmp_path, FAKE_OK))
    monkeypatch.setattr(rd, "SESSIONS_DIR", tmp_path)
    monkeypatch.setattr(rd, "WORKDIR", str(tmp_path))
    monkeypatch.setattr(rd, "fetch_brief", lambda i, m, t, r=None: seen.update(item=i, mode=m, text=t, run=r) or {"brief": "# brief", "prompt": t})
    monkeypatch.setattr(rd, "build_command", lambda mode, session, *a, **k: (seen.update(session=session), [rd.CLAUDE])[1])
    monkeypatch.setattr(rd, "run_claude", (lambda real: lambda cmd, prompt, timeout, on_line, stop, env=None, **k: real(cmd, prompt, timeout, on_line, stop, env=env, cwd=str(tmp_path)))(rd.run_claude))

    assert rd.main([run]) == 0
    cur.execute("select status, cost_usd::float8, session_id, pid is not null, finished_at is not null from relay_desk_run where id = %s", (run,))
    assert cur.fetchone() == ("done", 0.31, "s-fake", True, True)
    cur.execute("select desk_session_id from relay_item where id = %s", (item,))
    session = cur.fetchone()[0]
    assert seen["session"] == ["--session-id", session] and seen == {**seen, "item": item, "mode": "chat", "text": "shorter", "run": run}
    cur.execute("select role, text, applied->'desk'->>'tool' from relay_talk where item_id = %s order by created_at", (item,))
    assert cur.fetchall() == [("trace", "Read the email and its drafts", "mcp__relay__relay_state"), ("relay", "Got: shorter", None)]
    # Claimed once: running it again does nothing.
    assert rd.main([run]) == 0
    cur.execute("delete from relay_item where id = %s", (item,))
    conn.close()
