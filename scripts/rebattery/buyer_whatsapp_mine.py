#!/usr/bin/env python3
"""Reads exported WhatsApp chats with traders and proposes buy-boxes and buyer profile values, like the email miner.

  buyer_whatsapp_mine.py extract DIR --map "CHAT NAME=COMPANY_ID" ... [--workers 4]

DIR holds one folder per exported chat (WhatsApp's "_chat.txt"). Each --map ties a chat folder name to a CRM company
id; a chat mapped to "new:<Company name>" is read and reviewed but has no CRM company yet. The run folder has the same
results.json, review.md and gaps.md as the email miner, and loads with `buyer_email_mine.py apply RUN_DIR`, which
records these buy-boxes with the source "WhatsApp". Alex's own messages are "ours"; attachments are skipped.
"""
import argparse
import datetime as dt
import json
import re
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import buyer_email_mine as mine  # noqa: E402

LINE = re.compile(r"^‎?\[(\d{2})/(\d{2})/(\d{4}), (\d{2}):(\d{2}):(\d{2})\] ([^:]+): (.*)$")
SKIP = re.compile(r"(image|video|audio|sticker|GIF|document) omitted|<attached: |This message was deleted|Messages and calls are end-to-end", re.I)
OURS = {"alex", "alex polglase"}
MAX_CHAT_CHARS = 160000
SYSTEM = mine.SYSTEM.replace("full email history with ONE company", "WhatsApp chat history with ONE trader or company").replace(
    '"ours" = written by ReBattery (alex@ or ari@rebattery.io)', '"ours" = written by Alex of ReBattery')


def parse_chat(text, slug):
    """Messages from a WhatsApp export, oldest first. Consecutive messages from one sender on one day become one item,
    so a quote can span the lines someone sent in a row."""
    items = []
    for raw in text.replace("\r\n", "\n").split("\n"):
        line = raw.replace(" ", " ")
        hit = LINE.match(line)
        if hit:
            day, month, year, hh, mm, ss, sender, body = hit.groups()
            date = f"{year}-{month}-{day}"
            sender = sender.strip().strip("‪‬")
            if SKIP.search(body):
                continue
            body = body.replace("‎", "").strip()
            if items and items[-1]["sender"] == sender and items[-1]["date"] == date:
                items[-1]["text"] += "\n" + body
            else:
                items.append({"date": date, "sender": sender, "text": body,
                              "from": "ours" if sender.lower() in OURS else "theirs"})
        elif items and line.strip() and not SKIP.search(line):
            items[-1]["text"] += "\n" + line.replace("‎", "").strip()
    for i, item in enumerate(items):
        item["message_id"] = f"wa:{slug}:{i}"
        item["subject"] = None
        item["text"] = item["text"][:mine.MAX_MESSAGE_CHARS * 2]
    return items


def newest(items, limit=MAX_CHAT_CHARS):
    """The newest messages that fit, oldest first, and how many older ones were cut."""
    out, size = [], 0
    for item in reversed(items):
        size += len(item["text"]) + 60
        if size > limit and out:
            break
        out.append(item)
    out.reverse()
    return out, len(items) - len(out)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    e = sub.add_parser("extract")
    e.add_argument("dir")
    e.add_argument("--map", action="append", default=[], help='"CHAT FOLDER NAME=COMPANY_ID" or "...=new:Company name"')
    e.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()

    import psycopg2
    import psycopg2.extras
    conn = psycopg2.connect("host=/var/run/postgresql dbname=denchclaw")
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        mapping = dict(m.split("=", 1) for m in args.map)
        ids = [c for c in mapping.values() if not c.startswith("new:")]
        cur.execute("select id, name from crm_companies where id = any(%s)", (ids,))
        names = {r["id"]: r["name"] for r in cur.fetchall()}
        jobs = []
        for chat, company_id in mapping.items():
            text = "\n".join(p.read_text(errors="replace") for p in sorted((Path(args.dir) / chat).rglob("*.txt")))
            slug = re.sub(r"[^a-z0-9]+", "-", chat.lower()).strip("-")[:40]
            messages, cut = newest(parse_chat(text, slug))
            name = company_id[4:] if company_id.startswith("new:") else names.get(company_id, company_id)
            jobs.append(({"company_id": company_id, "name": name, "chat": chat, "messages_read": len(messages),
                          "messages_cut": cut, "source_kind": "import", "source_label": "WhatsApp"}, messages))
    key = mine.check.gateway_key()
    run = mine.RUNS / ("whatsapp-" + dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    run.mkdir(parents=True, exist_ok=True)
    results, lock = [None] * len(jobs), threading.Lock()

    def run_one(index):
        base, messages = jobs[index]
        print(f"reading {base['chat']}: {len(messages)} messages", file=sys.stderr, flush=True)
        try:
            raw = mine.check.call_model(SYSTEM, json.dumps({"COMPANY": base["name"], "MESSAGES": messages},
                                                           ensure_ascii=False, default=str), key)
            result = {**base, **mine.validate(raw, messages)}
        except Exception as err:
            result = {**base, "role": "other", "summary": f"Model call failed ({type(err).__name__}).", "buy_boxes": [],
                      "profile": {}, "other_facts": [], "dropped": 0, "error": True}
        print(f"done {base['chat']}: {result['role']}, {len(result['buy_boxes'])} buy-boxes", file=sys.stderr, flush=True)
        with lock:
            results[index] = result
            (run / "results.json").write_text(json.dumps([r for r in results if r], indent=1, ensure_ascii=False, default=str))

    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        list(pool.map(run_one, range(len(jobs))))
    conn = psycopg2.connect("host=/var/run/postgresql dbname=denchclaw")
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        for r in results:
            r["conflicts"] = [] if r["company_id"].startswith("new:") else mine.conflicts(cur, r)
    (run / "results.json").write_text(json.dumps(results, indent=1, ensure_ascii=False, default=str))
    (run / "review.md").write_text(mine.review_md(results))
    (run / "gaps.md").write_text(mine.gaps_md(results))
    print(run)
    return 0


if __name__ == "__main__":
    sys.exit(main())
