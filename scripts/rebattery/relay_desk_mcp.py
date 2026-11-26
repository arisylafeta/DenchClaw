#!/usr/bin/env python3
"""Relay desk MCP server: Relay's own tools for the desk's Claude Code session, over stdio, with no dependencies.

Started by Claude Code from the --mcp-config that relay_desk.py writes for each run, with RELAY_DESK_ITEM (the Relay
email) and RELAY_DESK_RUN (the desk run) in its environment. Every tool is a POST to the CRM's internal endpoint
/api/relay/internal/desk/tools/<tool> with the internal secret (read from its 0600 file, never from the environment or
argv). The CRM does the work through Relay's guarded code: the leak guard, history and Undo, version checks, the gap
fields. Nothing here writes, sends or creates a Gmail draft on its own.

RELAY_DESK_DRY_RUN=1: the CRM runs every check and says what each write tool would do, without writing.
Speaks newline-delimited JSON-RPC 2.0 (MCP stdio): initialize, notifications/initialized, ping, tools/list, tools/call.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from typing import Any, Callable

CRM_URL = os.environ.get("RELAY_CRM_URL", "http://127.0.0.1:3100").rstrip("/")
SECRET_FILE = os.environ.get("RELAY_INTERNAL_SECRET_FILE", "/root/.hermes/workspace/secrets/relay-internal.secret")
PROTOCOL_VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")
TOOL_TIMEOUT = 150
SERVER_INFO = {"name": "relay", "version": "1.0.0"}

_S = {"type": "string"}
_EMAILS = {"type": "array", "items": {"type": "string"}}


def _schema(props: dict, required: list[str] | None = None) -> dict:
    return {"type": "object", "properties": props, "required": required or [], "additionalProperties": False}


TOOLS: list[dict[str, Any]] = [
    {"name": "relay_state", "description": "The email at hand: who it is from, their contact type and deal, the thread (cleaned, newest first, with message ids), "
     "Relay's drafts (id, role, to/cc/bcc, subject, body, version, send mode, prices with working), the stock that fits with Relay's prices, and Alex's active rules. "
     "Call it before changing a draft, and again if a change is refused because the draft changed.", "inputSchema": _schema({}),
     "annotations": {"readOnlyHint": True}},
    {"name": "relay_write_reply", "description": "Write the reply: creates it (reply-all, from the right inbox) when there is none, or replaces the current one "
     "(Undo keeps the old copy). Then Relay prices any price markers. Refused if it would leak supplier or buyer details, or while a send is waiting.",
     "inputSchema": _schema({"body": {**_S, "description": "The whole reply text, no signature block."}, "subject": _S,
                             "reason": {**_S, "description": "What this reply does, in a few words."}}, ["body"])},
    {"name": "relay_update_draft", "description": "Change one Relay draft: its text, subject, To, Cc or Bcc. Pass the version from relay_state. Recorded as Relay's change "
     "so Alex can Undo it. Refused if it would leak, if the draft changed since (call relay_state again), or while a send is waiting.",
     "inputSchema": _schema({"draft_id": _S, "version": _S, "body": _S, "subject": _S, "to": _EMAILS, "cc": _EMAILS, "bcc": _EMAILS, "reason": _S},
                            ["draft_id", "version"])},
    {"name": "relay_add_email", "description": "Add a linked email beside the reply: to a supplier, the buyer (a chase) or someone else (transport, an intro). "
     "send_mode: with_reply (goes when Alex sends the reply), at or unless_reply (at send_at; unless_reply only if they haven't written first), after_order. "
     "on_thread: a chase to the person on this thread goes on the thread. reply_on: the Thread id (relay_state related, or relay_threads) of that person's own "
     "thread, so it goes there instead of as a new email; when a reply is already waiting there, pass its version as draft_version and the whole text, "
     "keeping what it says. Leak-guarded. Never sends.",
     "inputSchema": _schema({"to": _S, "to_kind": {"type": "string", "enum": ["buyer", "supplier", "other"]}, "subject": _S, "body": _S,
                             "send_mode": {"type": "string", "enum": ["with_reply", "at", "unless_reply", "after_order"]},
                             "send_at": {**_S, "description": "ISO time, for at and unless_reply."}, "why": {**_S, "description": "What it asks for, in a few words (its title on the page)."}, "on_thread": {"type": "boolean"},
                             "reply_on": {**_S, "description": "The Thread id to reply on; the subject is then the thread's."},
                             "draft_version": {**_S, "description": "With reply_on: the version of the reply waiting there, to change it."}},
                            ["to", "to_kind", "body"])},
    {"name": "relay_set_price", "description": "Set Relay's price (whole pounds) for one price gap in a draft, by its ref key; null clears it. Shown in yellow until Alex accepts it.",
     "inputSchema": _schema({"draft_id": _S, "key": _S, "value": {"type": ["number", "null"]}}, ["draft_id", "key", "value"])},
    {"name": "relay_reprice", "description": "Work Relay's prices out again for every price gap in a draft. Prices Alex set stay.",
     "inputSchema": _schema({"draft_id": _S}, ["draft_id"])},
    {"name": "relay_add_todo", "description": "Suggest a to-do for Alex (something the reply promises he will do).",
     "inputSchema": _schema({"title": _S, "detail": _S}, ["title"])},
    {"name": "relay_remember_lesson", "description": "Add one lesson to Alex's email-writing lessons (the file every draft and Claude session follows). Only after Alex has said yes to remembering it.",
     "inputSchema": _schema({"text": _S, "why": _S}, ["text"])},
    {"name": "relay_ask", "description": "Ask Alex a question only he can decide (buy, sell, list, price, pass), with two to four tap-to-answer options. End your turn after asking.",
     "inputSchema": _schema({"question": _S, "options": {"type": "array", "items": _S, "minItems": 2, "maxItems": 4}}, ["question", "options"])},
    {"name": "relay_propose_listings", "description": "Propose draft marketplace listings for a seller who has agreed to list and sent their details: one group per battery "
     "type they named, from what they stated only (no condition grade, SoH, or a price they didn't give). Alex approves on the card; Relay then creates the drafts "
     "under ReBattery Sales with their photos, issues the one-click link (set a password, accept the seller terms, add price and quantity) and puts it in the reply "
     "where you wrote [BLANK: listing link]. Not for a dismantler with listing permission or a seller who already lists (refused with the reason).",
     "inputSchema": _schema({"groups": {"type": "array", "minItems": 1, "maxItems": 6, "items": {"type": "object", "properties": {
         "label": {"type": "string", "description": "How the group is named, e.g. Samsung 35E e-bike packs"},
         "format": {"type": "string", "enum": ["Pack", "Module", "Cell"]},
         "description": {"type": "string", "description": "The listing description, from the seller's own facts"},
         "manufacturer": _S, "model": _S, "chemistry": _S, "quantity": {"type": "number"}, "packKwh": {"type": "number", "description": "kWh per unit, nominal"},
         "voltageNominal": {"type": "number"}, "numCells": _S, "cellFormat": _S,
         "originalApplication": {"type": "string", "enum": ["EV / automotive", "Home energy storage", "Commercial / grid storage", "Forklift / material handling", "Telecom / UPS", "E-mobility", "New / never used", "Other"]},
         "conditionDeclaration": {"type": "string", "enum": ["none_damaged", "some_damaged"]}, "damageDetails": _S,
         "buyItNowPrice": {"type": "number", "description": "Only a price the seller stated"}, "currency": {"type": "string", "enum": ["GBP", "EUR", "USD"]},
         "location": {"type": "object", "properties": {"country": _S, "countryCode": _S, "region": _S, "city": _S}, "required": ["country", "countryCode"]}},
         "required": ["label", "format", "description", "location"]}}, "why": _S}, ["groups"])},
    {"name": "relay_threads", "description": "Alex's Relay threads with a person (email address, name or company), the one about the same thing first: their newest email "
     "on each, and the reply waiting there with its version. Read only.",
     "inputSchema": _schema({"person": _S, "about": {**_S, "description": "Words it is about: the pack, a stock tag."}}, ["person"]), "annotations": {"readOnlyHint": True}},
    {"name": "crm_query", "description": "Read the CRM database (Postgres): ONE statement starting with SELECT or WITH, read only, 10 second limit, at most 200 rows. "
     "Useful tables: crm_people, crm_companies, crm_bulk_listings (deals), crm_stock_opportunities (supplier stock), mail_message, whatsapp_message, crm_price_cards.",
     "inputSchema": _schema({"sql": _S}, ["sql"]), "annotations": {"readOnlyHint": True}},
    {"name": "marketplace_account", "description": "Their account on the ReBattery marketplace, by email: signed up when, accounts, listings, deals, offers. Read only.",
     "inputSchema": _schema({"email": _S}, ["email"]), "annotations": {"readOnlyHint": True}},
    {"name": "marketplace_listings", "description": "Published marketplace listings whose title has every word of the query (make, model, kWh), with price and seller. Read only.",
     "inputSchema": _schema({"query": _S, "limit": {"type": "number"}}), "annotations": {"readOnlyHint": True}},
    {"name": "marketplace_deal", "description": "One marketplace listing or deal by its id. Read only.",
     "inputSchema": _schema({"id": _S}, ["id"]), "annotations": {"readOnlyHint": True}},
    {"name": "attachment_text", "description": "The text of an email's attachments (PDF, spreadsheet, Word), by the message id from relay_state. Read only.",
     "inputSchema": _schema({"message_id": _S}, ["message_id"]), "annotations": {"readOnlyHint": True}},
    {"name": "penny_price", "description": "Penny's price card for a battery (quick, expected and patient £/kWh, confidence). Read only.",
     "inputSchema": _schema({"battery": _S}, ["battery"]), "annotations": {"readOnlyHint": True}},
]
TOOL_NAMES = {t["name"] for t in TOOLS}


def read_secret(path: str = SECRET_FILE) -> str:
    with open(path, encoding="utf-8") as handle:
        return handle.read().strip()


def http_post(url: str, body: dict, secret: str, timeout: int = TOOL_TIMEOUT) -> tuple[int, dict]:
    """POST JSON with the internal secret; the status and the JSON answer (an error answer is JSON too)."""
    request = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                     headers={"content-type": "application/json", "authorization": f"Bearer {secret}"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as error:
        try:
            return error.code, json.loads(error.read() or b"{}")
        except ValueError:
            return error.code, {"error": f"The CRM answered {error.code}."}


class Server:
    """The JSON-RPC handling, apart from stdio so it can be tested. post: (url, body) -> (status, json)."""

    def __init__(self, item: str, run: str, dry_run: bool, post: Callable[[str, dict], tuple[int, dict]], crm_url: str = CRM_URL, as_of: str | None = None):
        self.item, self.run, self.dry_run, self.post, self.crm_url = item, run, dry_run, post, crm_url
        self.as_of = as_of if dry_run else None  # a replay (technical test set) is always a dry run

    def call_tool(self, name: str, args: Any) -> dict:
        if name not in TOOL_NAMES:
            return {"content": [{"type": "text", "text": f"Unknown tool {name}."}], "isError": True}
        body = {"item": self.item, "run": self.run, "args": args if isinstance(args, dict) else {}, "dry_run": self.dry_run}
        if self.as_of:
            body["as_of"] = self.as_of
        try:
            status, answer = self.post(f"{self.crm_url}/api/relay/internal/desk/tools/{name}", body)
        except (OSError, ValueError) as error:  # the CRM down or a broken answer: the desk is told, and carries on
            return {"content": [{"type": "text", "text": f"Couldn't reach Relay: {str(error)[:200]}"}], "isError": True}
        if status == 200 and isinstance(answer.get("text"), str):
            return {"content": [{"type": "text", "text": answer["text"]}], "isError": False}
        return {"content": [{"type": "text", "text": str(answer.get("error") or f"Relay answered {status}.")}], "isError": True}

    def handle(self, message: Any) -> dict | None:
        """One JSON-RPC message in; the response, or None for a notification."""
        if not isinstance(message, dict) or message.get("jsonrpc") != "2.0" or not isinstance(message.get("method"), str):
            return {"jsonrpc": "2.0", "id": message.get("id") if isinstance(message, dict) else None,
                    "error": {"code": -32600, "message": "Invalid request"}}
        method, params, has_id = message["method"], message.get("params") or {}, "id" in message
        if not has_id:
            return None  # notifications/initialized, notifications/cancelled: nothing to answer
        reply = lambda result: {"jsonrpc": "2.0", "id": message["id"], "result": result}  # noqa: E731
        if method == "initialize":
            asked = params.get("protocolVersion") if isinstance(params, dict) else None
            return reply({"protocolVersion": asked if asked in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[0],
                          "capabilities": {"tools": {"listChanged": False}}, "serverInfo": SERVER_INFO})
        if method == "ping":
            return reply({})
        if method == "tools/list":
            return reply({"tools": TOOLS})
        if method == "tools/call":
            if not isinstance(params, dict) or not isinstance(params.get("name"), str):
                return {"jsonrpc": "2.0", "id": message["id"], "error": {"code": -32602, "message": "tools/call needs a name"}}
            return reply(self.call_tool(params["name"], params.get("arguments") or {}))
        return {"jsonrpc": "2.0", "id": message["id"], "error": {"code": -32601, "message": f"Method not found: {method}"}}

    def serve(self, stdin=sys.stdin, stdout=sys.stdout) -> None:
        for line in stdin:
            if not line.strip():
                continue
            try:
                message = json.loads(line)
            except ValueError:
                response: dict | None = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}}
            else:
                response = self.handle(message)
            if response is not None:
                stdout.write(json.dumps(response) + "\n")
                stdout.flush()


def main() -> int:
    item, run = os.environ.get("RELAY_DESK_ITEM", ""), os.environ.get("RELAY_DESK_RUN", "")
    if not item:
        sys.stderr.write("relay_desk_mcp: RELAY_DESK_ITEM is not set\n")
        return 2
    secret = read_secret()
    Server(item, run, os.environ.get("RELAY_DESK_DRY_RUN") == "1", lambda url, body: http_post(url, body, secret), as_of=os.environ.get("RELAY_DESK_AS_OF") or None).serve()
    return 0


if __name__ == "__main__":
    sys.exit(main())
