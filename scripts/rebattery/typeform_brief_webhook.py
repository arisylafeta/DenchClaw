#!/usr/bin/env python3
"""Receives the Typeform Buyer Sourcing Brief (form MbMTVSu8) and files it: a CRM demand row when it qualifies,
a person and company for the sender, and a row in sourcing_intake_queue so a reply gets drafted. No notification email.

  typeform_brief_webhook.py --serve            # listen on 127.0.0.1:$PORT (default 3301) behind the nginx route
  typeform_brief_webhook.py --payload FILE     # file one saved webhook payload; add --apply to write

Typeform signs the raw body: header `Typeform-Signature: sha256=<base64 hmac-sha256>`, secret in TYPEFORM_WEBHOOK_SECRET.
A request with a missing or wrong signature is refused before anything is read.
"""
import argparse
import base64
import hashlib
import hmac
import json
import os
import sys
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import demand_survey_import as survey  # noqa: E402

FORM_ID = "MbMTVSu8"
MAX_BODY = 1_000_000


def signature_ok(secret, body, header):
    if not secret or not header or not header.startswith("sha256="):
        return False
    expected = base64.b64encode(hmac.new(secret.encode(), body, hashlib.sha256).digest()).decode()
    return hmac.compare_digest(expected, header[len("sha256="):])


def answer_text(answer):
    kind = answer.get("type")
    if kind == "choice":
        choice = answer.get("choice") or {}
        return choice.get("label") or choice.get("other") or ""
    if kind == "choices":
        choices = answer.get("choices") or {}
        return [*choices.get("labels", []), *([choices["other"]] if choices.get("other") else [])]
    if kind in ("text", "email", "url", "date", "phone_number", "file_url", "payment"):
        return str(answer.get(kind) or "")
    if kind == "number":
        return "" if answer.get("number") is None else str(answer["number"])
    if kind == "boolean":
        return "Yes" if answer.get("boolean") else "No"
    return ""


def payload_to_table(payload):
    """The webhook answers as the (header, row) pair the Typeform CSV importer reads: a column per question, and for a
    multi-select one column per picked option, named by the option."""
    response = payload["form_response"]
    titles = {f["id"]: f.get("title", "") for f in (response.get("definition") or {}).get("fields", [])}
    header, row = ["#", "Response Type", "Submit Date (UTC)"], [response.get("token", ""), "completed", response.get("submitted_at", "")]
    for answer in response.get("answers") or []:
        field = answer.get("field") or {}
        title = titles.get(field.get("id")) or field.get("ref") or ""
        value = answer_text(answer)
        if isinstance(value, list):
            header.append(title)
            row.append(", ".join(value))
            for label in value:
                header.append(label)
                row.append(label)
        else:
            header.append(title)
            row.append(value)
    for key, value in (response.get("hidden") or {}).items():
        if value:
            header.append(key)
            row.append(str(value))
    return header, row


def file_brief(cur, payload, apply=True):
    """Files one brief. Returns what happened. Idempotent on the response token."""
    response = payload["form_response"]
    if response.get("form_id") != FORM_ID:
        return {"status": "ignored", "reason": "other form"}
    header, row = payload_to_table(payload)
    token = response.get("token") or ""
    mapped = survey.map_typeform_row(header, row)
    stem = dict(zip(header, row))
    email = (stem.get("What's your email?") or stem.get("email") or "").strip().lower()
    if not email or survey.internal(email):
        return {"status": "skipped", "reason": "internal or no email"}
    cur.execute("select id from sourcing_intake_queue where source = 'typeform_brief' and source_id = %s", (token,))
    if cur.fetchone():
        return {"status": "duplicate"}
    demand_id = None
    if mapped:
        survey.link(cur, mapped)
        survey.insert(cur, mapped)
        cur.execute("select id from crm_bulk_demand where source_kind = %s and source_id = %s", (mapped["source_kind"], mapped["source_id"]))
        found = cur.fetchone()
        demand_id = found and found["id"]
    details = {"answers": dict(zip(header, row)), "form_id": FORM_ID}
    wants = (mapped or {}).get("wants") or stem.get("What will you use these batteries for?") or "Buyer brief"
    buyer = (mapped or {}).get("buyer") or stem.get("What's your name?") or email
    cur.execute(
        """insert into sourcing_intake_queue (id, source, source_id, email, buyer, wants, received_at, demand_id, details)
           values (%s, 'typeform_brief', %s, %s, %s, %s, coalesce(nullif(%s, '')::timestamptz, now()), %s, %s::jsonb)""",
        [f"siq_{uuid.uuid4()}", token, email, buyer, wants, response.get("submitted_at") or "", demand_id, json.dumps(details)])
    return {"status": "queued", "demand_id": demand_id, "email": email}


def handle(payload, dsn, apply=True):
    import psycopg2
    import psycopg2.extras
    conn = psycopg2.connect(dsn)
    try:
        with conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            result = file_brief(cur, payload)
            if not apply:
                conn.rollback()
        return result
    finally:
        conn.close()


def make_handler(secret, dsn):
    class Handler(BaseHTTPRequestHandler):
        def _reply(self, code, body):
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            length = int(self.headers.get("content-length") or 0)
            if length > MAX_BODY:
                return self._reply(413, {"ok": False})
            body = self.rfile.read(length)
            if not signature_ok(secret, body, self.headers.get("Typeform-Signature")):
                return self._reply(401, {"ok": False})
            try:
                payload = json.loads(body)
                if payload.get("event_type") != "form_response":
                    return self._reply(200, {"ok": True, "status": "ignored"})
                self._reply(200, {"ok": True, **handle(payload, dsn)})
            except Exception as error:  # Typeform retries a 5xx, so a failure here is not lost
                print(f"typeform brief failed: {type(error).__name__}", file=sys.stderr)
                self._reply(500, {"ok": False})

        def log_message(self, *_):
            pass

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dsn", default="host=/var/run/postgresql dbname=denchclaw")
    parser.add_argument("--serve", action="store_true")
    parser.add_argument("--payload")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    if args.serve:
        secret = os.environ.get("TYPEFORM_WEBHOOK_SECRET", "")
        if not secret:
            raise SystemExit("TYPEFORM_WEBHOOK_SECRET is not set")
        port = int(os.environ.get("PORT", "3301"))
        HTTPServer(("127.0.0.1", port), make_handler(secret, args.dsn)).serve_forever()
    elif args.payload:
        print(json.dumps(handle(json.load(open(args.payload)), args.dsn, apply=args.apply)))
    else:
        parser.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
