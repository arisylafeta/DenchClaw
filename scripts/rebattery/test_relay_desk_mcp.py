import io
import json

import relay_desk_mcp as mcp


def server(answer=(200, {"text": "ok"}), dry=False):
    calls = []

    def post(url, body):
        calls.append((url, body))
        if isinstance(answer, Exception):
            raise answer
        return answer

    return mcp.Server("item-1", "run-1", dry, post, crm_url="http://crm"), calls


def test_initialize_echoes_a_known_protocol_and_offers_tools():
    s, _ = server()
    r = s.handle({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-03-26"}})
    assert r["result"]["protocolVersion"] == "2025-03-26"
    assert r["result"]["capabilities"] == {"tools": {"listChanged": False}}
    assert r["result"]["serverInfo"]["name"] == "relay"
    unknown = s.handle({"jsonrpc": "2.0", "id": 2, "method": "initialize", "params": {"protocolVersion": "1999-01-01"}})
    assert unknown["result"]["protocolVersion"] == mcp.PROTOCOL_VERSIONS[0]


def test_notifications_get_no_answer():
    s, _ = server()
    assert s.handle({"jsonrpc": "2.0", "method": "notifications/initialized"}) is None
    assert s.handle({"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": 3}}) is None


def test_tools_list_has_every_relay_tool_with_a_schema():
    s, _ = server()
    tools = s.handle({"jsonrpc": "2.0", "id": 3, "method": "tools/list"})["result"]["tools"]
    names = [t["name"] for t in tools]
    assert names == ["relay_state", "relay_write_reply", "relay_update_draft", "relay_add_email", "relay_set_price", "relay_reprice", "relay_add_todo",
                     "relay_remember_lesson", "relay_ask", "crm_query", "marketplace_account", "marketplace_listings", "marketplace_deal", "attachment_text", "penny_price"]
    for t in tools:
        assert t["inputSchema"]["type"] == "object" and t["description"]
    assert not any("send" in n or "gmail" in n for n in names)


def test_tools_call_posts_to_the_crm_with_item_run_and_dry_run():
    s, calls = server(answer=(200, {"text": "DRY RUN, nothing was changed."}), dry=True)
    r = s.handle({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "relay_write_reply", "arguments": {"body": "Hi Ben"}}})
    assert r["result"] == {"content": [{"type": "text", "text": "DRY RUN, nothing was changed."}], "isError": False}
    assert calls == [("http://crm/api/relay/internal/desk/tools/relay_write_reply", {"item": "item-1", "run": "run-1", "args": {"body": "Hi Ben"}, "dry_run": True})]


def test_a_refusal_comes_back_as_a_tool_error_the_desk_can_read():
    s, _ = server(answer=(422, {"error": "That would tell the buyer the supplier's name."}))
    r = s.handle({"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "relay_update_draft", "arguments": {}}})
    assert r["result"]["isError"] is True
    assert "supplier's name" in r["result"]["content"][0]["text"]


def test_the_crm_down_is_a_tool_error_not_a_crash():
    s, _ = server(answer=OSError("connection refused"))
    r = s.handle({"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {"name": "relay_state"}})
    assert r["result"]["isError"] is True and "Couldn't reach Relay" in r["result"]["content"][0]["text"]


def test_unknown_tools_and_methods_and_bad_requests():
    s, calls = server()
    r = s.handle({"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {"name": "send_message", "arguments": {}}})
    assert r["result"]["isError"] is True and calls == []
    assert s.handle({"jsonrpc": "2.0", "id": 8, "method": "resources/list"})["error"]["code"] == -32601
    assert s.handle({"jsonrpc": "2.0", "id": 9, "method": "tools/call", "params": {}})["error"]["code"] == -32602
    assert s.handle({"id": 10, "method": "ping"})["error"]["code"] == -32600
    assert s.handle({"jsonrpc": "2.0", "id": 11, "method": "ping"}) == {"jsonrpc": "2.0", "id": 11, "result": {}}


def test_serve_reads_and_writes_newline_delimited_json():
    s, _ = server()
    stdin = io.StringIO("\n".join([
        json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}),
        json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}),
        "not json",
        "",
        json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "penny_price", "arguments": {"battery": "ID.3"}}}),
    ]) + "\n")
    out = io.StringIO()
    s.serve(stdin, out)
    replies = [json.loads(line) for line in out.getvalue().splitlines()]
    assert [r.get("id") for r in replies] == [1, None, 2]
    assert replies[1]["error"]["code"] == -32700
    assert replies[2]["result"]["content"][0]["text"] == "ok"


def test_main_needs_an_item(monkeypatch):
    monkeypatch.delenv("RELAY_DESK_ITEM", raising=False)
    assert mcp.main() == 2
