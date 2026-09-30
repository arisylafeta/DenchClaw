#!/usr/bin/env python3
"""Reads Alex's email history one company at a time and proposes buy-boxes and buyer profile values.

  buyer_email_mine.py extract --companies ID,ID [--also PERSON_ID=COMPANY_ID]   # one batch, read-only
  buyer_email_mine.py extract --top 20 --skip-reviewed --workers 4              # next 20 that most ask to buy, 4 at a time
  buyer_email_mine.py apply RUN_DIR [--only ID,ID] [--apply]                    # load an approved batch

extract writes a run folder under /root/.hermes/workspace/artifacts/buyer-email-mine/ with results.json (every
proposal with its evidence), review.md (the sheet Alex approves) and gaps.md (useful facts the CRM has no field
for). Nothing is written to the CRM.

Sources: Alex's mailbox only (crm_email_messages.mailbox_owner_id), every thread with an external participant,
both directions, oldest first. Quoted replies and signatures are cut. Each company's history goes to the model
in one call (the Hermes gateway), and every proposed value must quote a message exactly or it is dropped.

apply loads a reviewed run: buy-boxes become stated demand rows keyed by (email, message id + want), so a re-run
adds nothing twice; profile values fill only empty fields, and a different existing value is reported as a
conflict, never overwritten; the stage is set only when empty. Dry run unless --apply.
"""
import argparse
import datetime as dt
import hashlib
import json
import re
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bulk_trade_inbox_check as check  # noqa: E402  call_model, gateway_key, quote_ok, clean_structured, BUY_BOX
import demand_survey_import as survey  # noqa: E402  insert, link

REPO = Path(__file__).resolve().parents[2]
RUNS = Path("/root/.hermes/workspace/artifacts/buyer-email-mine")
MAILBOX = "alex@rebattery.io"
OWN = re.compile(r"@rebattery\.io$", re.I)
MAX_MESSAGE_CHARS = 2500
MAX_COMPANY_CHARS = 60000
CLOSED_REASONS = ["bought_from_us", "bought_elsewhere", "no_longer_needed", "expired", "other"]
CAPABILITIES = ["Dismantle packs", "Test and grade", "BMS repair", "Cell rebuild", "Recycle", "Integrate systems",
                "HV workshop", "Dangerous-goods shipping"]
STAGES = ["Contacted", "Responded", "In conversation", "Qualified", "Bidding", "Customer"]
# Fixed topics for other_facts, so facts group into candidate CRM fields across companies.
TOPICS = ["sites and capacity", "permits and certifications", "logistics and packaging", "contract and payment",
          "decision process and timing", "projects and end customers", "technical requirements",
          "supply they offer", "competitors and other suppliers", "people and contacts", "other"]

SYSTEM = """You read ReBattery's full email history with ONE company and record what they buy and how to deal with
them. ReBattery brokers second-life and surplus EV batteries, modules, cells and BESS. Messages are oldest first.
"from": "ours" = written by ReBattery (alex@ or ari@rebattery.io); "theirs" = written by the company.

Reply with ONLY JSON:
{
  "role": "buyer" | "seller" | "both" | "other",
  "summary": two or three plain sentences: who they are, what they do with batteries, where things stand with us,
  "buy_boxes": [{
    "kind": "request" | "standing",
    "wants": one line in THEIR words,
    "spec": {only keys and values from LISTS; omit anything they did not say},
    "volume": number or null, "volume_unit": one of VOLUME_UNITS or null,   (total for a request, per month if standing)
    "max_price": number or null, "price_currency": "EUR" | "USD" | "GBP" | null, "price_unit": "kWh" | "pack" | "cell" | null,
    "location": delivery country or region, or null,
    "needed_by": "YYYY-MM-DD" or null (requests only, only if stated),
    "status": "open" | "bought_from_us" | "bought_elsewhere" | "no_longer_needed" | "expired",
    "note": what matters that the spec cannot hold (voltage, connectors, use, timing, changes over time), their words,
    "evidence": [{"message_id", "quote"}]
  }],
  "profile": {
    "capabilities": [values from CAPABILITIES],
    "can_receive_waste": true | false | null,
    "accepts_standard_terms": "Yes" | "No" | null,   (ReBattery's standard: principal sale, EXW, paid before collection)
    "payment_terms": what they accept or ask for (LC, prepay, deposit, net 30...), or null,
    "collection": how they collect or ship (own ADR transport, forwarder, needs delivery...), or null,
    "past_issues": [{"date": "YYYY-MM-DD", "what": one line, "message_id", "quote"}],   (disputes, delays, rejected loads, late payment)
    "outreach_notes": what they care about, how they like to be approached, who decides; or null,
    "main_contact_email": the person who drives buying, or null,
    "stage": one of STAGES or null (the furthest reached: Bidding = they made an offer; Customer = they bought from us),
    "evidence": [{"field", "message_id", "quote"}]
  },
  "other_facts": [{"topic": one of TOPICS, "value": one line, "message_id", "quote"}]
}

Rules:
- Demand means buying for REUSE or SECOND LIFE only (repurposing, storage, conversions, resale for reuse).
  Buying batteries to recycle, shred or treat, scrap and black mass, gate fees and per-kg recycling prices are
  NOT demand: leave them out, and a company that only recycles is role "other".
- Record only what THEY said or clearly confirmed. ReBattery's pitches, teasers and offers are not their demand.
- request = a specific need now or by a date ("1,000 cells in 3 weeks"); standing = ongoing or repeat buying
  ("20-30 packs a month", "we buy LFP regularly"). A request they repeat three or more times is standing.
- One buy-box per distinct thing they want. When later messages change it, give the latest version and put the
  change in the note with its date. Set status from what happened later in the history.
- Never invent or infer a value; unknown is null. Spec values must match LISTS exactly, else use the note.
- Every buy-box, every profile value and every other fact needs evidence: a message_id from the input and a quote
  copied EXACTLY from that message (8 to 300 characters). No evidence, leave it out.
- other_facts: anything else that would help match batteries to this buyer or deal with them and that the fields
  above do not hold (certifications, sites and storage, lead times, end customers, OEM relationships, volumes
  bought elsewhere, budget cycles, languages, decision process). Skip small talk.
- Bids or offers they made on a specific ReBattery lot are demand with a price: record them as request buy-boxes
  with "wants" starting "Bid on <lot>:", and the status from what happened next.
- A seller or unrelated company: set role and leave buy_boxes empty; supply they offer goes in other_facts.
LISTS: %(lists)s
VOLUME_UNITS: %(volume_units)s
CAPABILITIES: %(capabilities)s
STAGES: %(stages)s
TOPICS: %(topics)s""" % {
    "lists": json.dumps(check.BUY_BOX["lists"], ensure_ascii=False), "volume_units": ", ".join(check.BUY_BOX["volume_units"]),
    "capabilities": ", ".join(CAPABILITIES), "stages": ", ".join(STAGES), "topics": ", ".join(TOPICS)}

QUOTED = re.compile(
    r"^(>|On .{5,200}wrote:\s*$|-{2,}\s*Original Message|From: .+\n(Sent|Date): |_{10,}|Sent from my |Von: .+\nGesendet)",
    re.M | re.I)
SIGNATURE = re.compile(r"^(--|—)\s*$", re.M)


def clean_body(text):
    """The new part of a message: cut at the first quoted reply or signature marker, squeeze blank lines."""
    text = (text or "").replace("\r\n", "\n")
    for pattern in (QUOTED, SIGNATURE):
        hit = pattern.search(text)
        if hit and hit.start() > 20:
            text = text[:hit.start()]
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return text[:MAX_MESSAGE_CHARS]


# ---------------------------------------------------------------------------
# Reading
# ---------------------------------------------------------------------------

def mailbox_id(cur):
    cur.execute("select id from crm_users where email = %s", (MAILBOX,))
    return cur.fetchone()["id"]


def company_people(cur, company_ids, also):
    """person_id -> company_id for the batch: everyone at the companies, plus extra people mapped by hand."""
    cur.execute("select id, company_id from crm_people where company_id = any(%s)", (company_ids,))
    people = {r["id"]: r["company_id"] for r in cur.fetchall()}
    people.update(also)
    return people


def company_history(cur, mailbox, person_ids):
    """Every message in Alex's mailbox on a thread where one of these people wrote or was addressed, oldest first."""
    cur.execute(
        """with threads as (
             select distinct m.thread_id from crm_email_messages m
             where m.mailbox_owner_id = %(mb)s and m.thread_id is not null
               and (m.from_person_id = any(%(p)s)
                    or exists (select 1 from crm_email_message_recipients r where r.message_id = m.id and r.person_id = any(%(p)s))))
           select m.id, m.thread_id, m.subject, m.sent_at, m.from_email, m.body, m.body_preview
           from crm_email_messages m join threads t on t.thread_id = m.thread_id
           where m.mailbox_owner_id = %(mb)s
           order by m.sent_at nulls first, m.id""", {"mb": mailbox, "p": list(person_ids)})
    return cur.fetchall()


def as_input(messages):
    """The model's view: cleaned messages, newest kept when the history is too long."""
    out, size = [], 0
    for m in reversed(messages):
        body = clean_body(m["body"] or m["body_preview"])
        if not body:
            continue
        item = {"message_id": m["id"], "date": m["sent_at"].date().isoformat() if m["sent_at"] else None,
                "from": "ours" if OWN.search(m["from_email"] or "") else "theirs",
                "sender": m["from_email"], "subject": m["subject"], "text": body}
        size += len(body) + 200
        if size > MAX_COMPANY_CHARS and out:
            break
        out.append(item)
    out.reverse()
    return out, len(messages) - len(out)


# Buying language beyond the inbox check's strict demand phrases: interest, availability, price and bids.
BUY_HINT = re.compile(
    r"\b(interested in|do you (have|still have)|have you got|any (more )?(stock|availability)|price (for|of|per)|"
    r"quot(e|ation) (for|on)|offer (for|of)|our (offer|bid)|we (can|could|would) (take|offer|pay|buy)|"
    r"we are (buying|sourcing)|still available|looking for|we need|demand is|our demand|demand for)\b", re.I)
FREE_MAIL = re.compile(r"^(gmail|googlemail|hotmail|outlook|yahoo|icloud|live|aol|proton(mail)?|gmx|web)\.", re.I)


def busiest(cur, mailbox, limit, skip):
    """Companies whose inbound mail in Alex's mailbox most often uses buying language, excluding ReBattery,
    free-mail pseudo-companies and companies already done."""
    cur.execute(
        """select p.company_id as id, c.name, m.body
           from crm_email_messages m join crm_people p on p.id = m.from_person_id join crm_companies c on c.id = p.company_id
           where m.mailbox_owner_id = %s and coalesce(m.from_email, '') !~* '@rebattery\\.io$'
             and c.name !~* 'rebattery' and not (p.company_id = any(%s))""", (mailbox, list(skip)))
    hits = {}
    for r in cur.fetchall():
        text = clean_body(r["body"])
        if FREE_MAIL.search(r["name"] or ""):
            continue  # a free-mail pseudo-company lumps unrelated people together
        if ((check.DEMAND_INTENT.search(text) or BUY_HINT.search(text)) and check.DEAL_WORDS.search(text)
                and not check.NEWSLETTER.search(text)):
            hits[r["id"]] = hits.get(r["id"], 0) + 1
    return [company for company, _ in sorted(hits.items(), key=lambda kv: -kv[1])[:limit]]


# ---------------------------------------------------------------------------
# Checking
# ---------------------------------------------------------------------------

RECYCLING = re.compile(r"recycl|black mass|scrap|gate fee|per kg|/kg|feedstock|end[- ]of[- ]life|shred|dismantl", re.I)
REUSE = re.compile(r"second[- ]life|re-?use|repurpos|resale|resell", re.I)


def recycling_only(box):
    """A buy-box about recycling with no sign of reuse: not demand (ReBattery's demand is reuse and second life)."""
    text = f"{box.get('wants') or ''} {box.get('note') or ''}"
    return bool(RECYCLING.search(text)) and not REUSE.search(text)


def evidence_ok(items, by_id):
    """Keeps evidence whose quote appears in the cited message; adds that message's date."""
    kept = []
    for e in items or []:
        if not isinstance(e, dict):
            continue
        message = by_id.get(str(e.get("message_id")))
        if message and check.quote_ok(e.get("quote"), message["text"]):
            kept.append({**e, "quote": str(e["quote"]).strip()[:300], "date": message["date"]})
    return kept


def validate(raw, messages):
    """The model's answer with every unquoted or out-of-list value removed."""
    by_id = {m["message_id"]: m for m in messages}
    result = {"role": raw.get("role") if raw.get("role") in ("buyer", "seller", "both", "other") else "other",
              "summary": str(raw.get("summary") or "").strip()[:800], "buy_boxes": [], "profile": {}, "other_facts": [],
              "dropped": 0}
    for box in raw.get("buy_boxes") or []:
        if not isinstance(box, dict) or not str(box.get("wants") or "").strip():
            continue
        if recycling_only(box):
            result["recycling_dropped"] = result.get("recycling_dropped", 0) + 1
            continue
        evidence = evidence_ok(box.get("evidence"), by_id)
        if not evidence:
            result["dropped"] += 1
            continue
        kind = box.get("kind") if box.get("kind") in ("request", "standing") else "standing"
        structured = check.clean_structured({**box, "kind": kind})
        status = box.get("status") if box.get("status") in ["open", *CLOSED_REASONS] else "open"
        result["buy_boxes"].append({
            **structured, "kind": kind, "wants": str(box["wants"]).strip()[:300], "status": status,
            "location": str(box.get("location") or "").strip()[:80] or None,
            "note": str(box.get("note") or "").strip()[:800] or None, "evidence": evidence,
            "observed_on": max(e["date"] for e in evidence if e["date"]) if any(e["date"] for e in evidence) else None})

    profile = raw.get("profile") if isinstance(raw.get("profile"), dict) else {}
    quoted = {}
    for e in evidence_ok(profile.get("evidence"), by_id):
        quoted.setdefault(str(e.get("field")), []).append(e)
    p = {}
    caps = [c for c in profile.get("capabilities") or [] if c in CAPABILITIES]
    if caps and quoted.get("capabilities"):
        p["capabilities"] = caps
    for field, allowed in (("can_receive_waste", (True, False)), ("accepts_standard_terms", ("Yes", "No")), ("stage", STAGES)):
        if profile.get(field) in allowed and quoted.get(field):
            p[field] = profile[field]
    for field in ("payment_terms", "collection", "outreach_notes"):
        value = str(profile.get(field) or "").strip()
        if value and quoted.get(field):
            p[field] = value[:800]
    email = str(profile.get("main_contact_email") or "").strip().lower()
    if email and "@" in email and not OWN.search(email) and any(email == (m["sender"] or "").lower() for m in messages):
        p["main_contact_email"] = email
    issues = []
    for issue in profile.get("past_issues") or []:
        if isinstance(issue, dict) and evidence_ok([issue], by_id):
            message = by_id[str(issue["message_id"])]
            issues.append({"date": message["date"], "what": str(issue.get("what") or "").strip()[:300],
                           "quote": str(issue["quote"]).strip()[:300], "message_id": issue["message_id"]})
    if issues:
        p["past_issues"] = issues
    p["evidence"] = quoted
    result["profile"] = p
    for fact in raw.get("other_facts") or []:
        if isinstance(fact, dict) and evidence_ok([fact], by_id):
            fact["topic"] = fact.get("topic") if fact.get("topic") in TOPICS else "other"
            message = by_id[str(fact["message_id"])]
            result["other_facts"].append({"topic": str(fact["topic"]).strip()[:60], "value": str(fact.get("value") or "").strip()[:300],
                                          "quote": str(fact["quote"]).strip()[:300], "date": message["date"],
                                          "message_id": fact["message_id"]})
    return result


# ---------------------------------------------------------------------------
# Review sheet
# ---------------------------------------------------------------------------

def box_line(box):
    bits = [box["kind"], box["status"] if box["status"] != "open" else None]
    if box.get("volume"):
        bits.append(f"{box['volume']:g} {box['volume_unit']}{' a month' if box['kind'] == 'standing' else ''}")
    if box.get("max_price"):
        bits.append(f"max {box['price_currency']} {box['max_price']:g}/{box['price_unit']}")
    if box.get("needed_by"):
        bits.append(f"by {box['needed_by']}")
    if box.get("location"):
        bits.append(box["location"])
    return " · ".join(b for b in bits if b)


def review_md(results):
    lines = ["# Buyer email mining: review", "",
             "Approve per company. Buy-boxes load as Stated (closed ones as history). Profile values fill empty fields only.", ""]
    for r in results:
        lines += [f"## {r['name']}", "", f"Role: {r['role']} · messages read: {r['messages_read']}"
                  + (f" (oldest {r['messages_cut']} cut)" if r["messages_cut"] else "")
                  + (f" · {r['dropped']} unquoted buy-box(es) dropped" if r["dropped"] else ""), ""]
        if r["summary"]:
            lines += [r["summary"], ""]
        if r["buy_boxes"]:
            lines.append("**Buy-boxes**")
            for i, box in enumerate(r["buy_boxes"], 1):
                lines.append(f"{i}. {box['wants']} ({box_line(box)})")
                spec = "; ".join(f"{k}: {', '.join(v) if isinstance(v, list) else v}" for k, v in (box.get("spec") or {}).items())
                if spec:
                    lines.append(f"   - Spec: {spec}")
                if box.get("note"):
                    lines.append(f"   - Note: {box['note']}")
                for e in box["evidence"][:2]:
                    lines.append(f"   - {e['date']}: “{e['quote']}”")
            lines.append("")
        p = r["profile"]
        shown = {k: v for k, v in p.items() if k not in ("evidence", "past_issues")}
        if shown or p.get("past_issues"):
            lines.append("**Profile**")
            for k, v in shown.items():
                lines.append(f"- {k.replace('_', ' ').capitalize()}: {', '.join(v) if isinstance(v, list) else v}")
            for issue in p.get("past_issues") or []:
                lines.append(f"- Past issue {issue['date']}: {issue['what']} (“{issue['quote']}”)")
            lines.append("")
        if r.get("conflicts"):
            lines.append("**Conflicts with the CRM (not overwritten)**")
            lines += [f"- {c}" for c in r["conflicts"]]
            lines.append("")
        if r["other_facts"]:
            lines.append("**Other facts**")
            lines += [f"- {f['topic']}: {f['value']} ({f['date']})" for f in r["other_facts"]]
            lines.append("")
    return "\n".join(lines)


def gaps_md(results):
    """Other facts grouped by topic: candidates for new CRM fields."""
    topics = {}
    for r in results:
        for f in r["other_facts"]:
            topics.setdefault(f["topic"].lower(), []).append((r["name"], f["value"]))
    lines = ["# Facts the CRM has no field for", "", "Grouped by topic, most common first.", ""]
    for topic, items in sorted(topics.items(), key=lambda kv: -len(kv[1])):
        lines.append(f"## {topic} ({len(items)})")
        lines += [f"- {name}: {value}" for name, value in items[:12]]
        lines.append("")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def extract(conn, args):
    import psycopg2.extras
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        mailbox = mailbox_id(cur)
        also = dict(pair.split("=", 1) for pair in args.also)
        done = set()
        if args.skip_reviewed:
            for f in RUNS.glob("*/results.json"):
                done.update(r["company_id"] for r in json.loads(f.read_text()))
        ids = [c for c in (args.companies or "").split(",") if c] or busiest(cur, mailbox, args.top, done)
        cur.execute("select id, name from crm_companies where id = any(%s)", (ids,))
        names = {r["id"]: r["name"] for r in cur.fetchall()}
        people = company_people(cur, ids, also)
        key = check.gateway_key()
        run = RUNS / dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        run.mkdir(parents=True, exist_ok=True)
        # Read every company's history first; the model calls then run in parallel.
        jobs = []
        for company_id in ids:
            person_ids = [p for p, c in people.items() if c == company_id]
            messages, cut = as_input(company_history(cur, mailbox, person_ids)) if person_ids else ([], 0)
            jobs.append(({"company_id": company_id, "name": names.get(company_id, company_id),
                          "messages_read": len(messages), "messages_cut": cut}, messages))
        results = [None] * len(jobs)
        lock = threading.Lock()

        def run_one(index):
            base, messages = jobs[index]
            if not messages:
                result = {**base, "role": "other", "summary": "No email in Alex's mailbox.", "buy_boxes": [],
                          "profile": {}, "other_facts": [], "dropped": 0}
            else:
                print(f"reading {base['name']}: {len(messages)} messages", file=sys.stderr, flush=True)
                try:
                    raw = check.call_model(SYSTEM, json.dumps({"COMPANY": base["name"], "MESSAGES": messages},
                                                              ensure_ascii=False, default=str), key)
                    result = {**base, **validate(raw, messages)}
                except Exception as err:  # one bad company does not stop the batch
                    result = {**base, "role": "other", "summary": f"Model call failed ({type(err).__name__}).",
                              "buy_boxes": [], "profile": {}, "other_facts": [], "dropped": 0, "error": True}
                print(f"done {base['name']}: {result['role']}, {len(result['buy_boxes'])} buy-boxes", file=sys.stderr, flush=True)
            with lock:
                results[index] = result
                (run / "results.json").write_text(json.dumps([r for r in results if r], indent=1,
                                                             ensure_ascii=False, default=str))

        with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
            list(pool.map(run_one, range(len(jobs))))
        for r in results:
            r["conflicts"] = conflicts(cur, r)
    (run / "results.json").write_text(json.dumps(results, indent=1, ensure_ascii=False, default=str))
    (run / "review.md").write_text(review_md(results))
    (run / "gaps.md").write_text(gaps_md(results))
    print(run)
    return 0


PROFILE_COLUMNS = {"capabilities": "buyer_capabilities", "can_receive_waste": "buyer_can_receive_waste",
                   "accepts_standard_terms": "buyer_accepts_standard_terms", "collection": "buyer_collection",
                   "stage": "buyer_stage"}


def profile_values(p, facts=(), summary=None):
    """Column -> value for a company's proposed profile; text fields are dated so the history stays readable.
    Projects come from the "projects and end customers" facts, the company summary goes to the empty about field."""
    today = dt.date.today().isoformat()
    values = {col: p[k] for k, col in PROFILE_COLUMNS.items() if k in p}
    projects = [f for f in facts if "project" in f["topic"].lower()]
    if projects:
        values["buyer_projects"] = "\n".join(f"{f['value']} ({f['date']})" for f in projects)
    if summary and not summary.startswith(("No email", "Model call failed")):
        values["about"] = summary
    notes = []
    if p.get("outreach_notes"):
        notes.append(p["outreach_notes"])
    if p.get("payment_terms"):
        notes.append(f"Payment: {p['payment_terms']}")
    if notes:
        values["buyer_outreach_notes"] = f"From email review {today}: " + " ".join(notes)
    if p.get("past_issues"):
        values["buyer_past_issues"] = "\n".join(f"{i['date']}: {i['what']}" for i in p["past_issues"])
    return values


def conflicts(cur, r):
    """Proposed profile values that differ from values already in the CRM."""
    values = profile_values(r.get("profile") or {}, r.get("other_facts") or [], r.get("summary"))
    if not values:
        return []
    cur.execute(f"select {', '.join(values)} from crm_companies where id = %s", (r["company_id"],))
    row = cur.fetchone() or {}
    out = []
    for col, value in values.items():
        current = row.get(col)
        if current not in (None, "", []) and current != value and col not in (
                "buyer_outreach_notes", "buyer_past_issues", "buyer_projects", "about"):
            out.append(f"{col}: CRM has {current!r}, email suggests {value!r}")
    return out


def apply(conn, args):
    import psycopg2.extras
    results = json.loads((Path(args.run) / "results.json").read_text())
    only = set(c for c in (args.only or "").split(",") if c)
    added = filled = 0
    with conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        for r in results:
            if only and r["company_id"] not in only or r.get("error"):
                continue
            if r["company_id"].startswith("new:"):
                print(f"skip (no CRM company yet): {r['name']}")
                continue
            source_kind, source_label = r.get("source_kind", "email"), r.get("source_label", "Alex's email")
            for box in r["buy_boxes"]:
                if recycling_only(box):
                    print(f"skip (recycling): {r['name']} | {box['wants'][:70]}")
                    continue
                digest = hashlib.sha1(box["wants"].encode()).hexdigest()[:10]
                row = {k: box.get(k) for k in ("kind", "wants", "location", "note", "volume", "volume_unit", "max_price",
                                                "price_currency", "price_unit", "needed_by", "spec", "observed_on")}
                row.update(basis="stated" if box["kind"] == "standing" else None, company_id=r["company_id"],
                           buyer=r["name"], source_kind=source_kind, source_label=source_label,
                           source_id=f"{source_kind}:{box['evidence'][0]['message_id']}:{digest}",
                           source_quote=box["evidence"][-1]["quote"])  # the latest quote: the buyer's current words
                if box["kind"] != "request":
                    row["needed_by"] = None
                survey.link(cur, row)
                new = survey.insert(cur, row)
                if new and box["status"] != "open":
                    cur.execute("""update crm_bulk_trade_demand set status = 'closed', closed_reason = %s
                                   where source_kind = %s and source_id = %s""", (box["status"], source_kind, row["source_id"]))
                added += new
                print(f"{'add' if new else 'already in'}: {r['name']} | {box['kind']} {box['status']} | {box['wants'][:70]}")
            values = profile_values(r.get("profile") or {}, r.get("other_facts") or [], r.get("summary"))
            email = (r.get("profile") or {}).get("main_contact_email")
            if email:
                cur.execute("select id from crm_people where lower(email) = %s limit 1", (email,))
                person = cur.fetchone()
                if person:
                    values["buyer_main_contact_id"] = person["id"]
            for col, value in values.items():
                # Empty fields only: a value someone set is never overwritten.
                cur.execute(f"""update crm_companies set {col} = %s, updated_at = now()
                                where id = %s and ({col} is null or {col}::text in ('', '{{}}')) returning id""",
                            (value, r["company_id"]))
                if cur.fetchone():
                    filled += 1
                    print(f"  set {col} on {r['name']}")
            cur.execute("update crm_companies set buyer_last_reviewed_at = now() where id = %s", (r["company_id"],))
        if not args.apply:
            conn.rollback()
    print(f"{'added' if args.apply else 'would add'} {added} buy-boxes and fill {filled} profile fields")
    return 0


def main():
    import psycopg2
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dsn", default="host=/var/run/postgresql dbname=denchclaw")
    sub = parser.add_subparsers(dest="command", required=True)
    e = sub.add_parser("extract")
    e.add_argument("--companies", help="comma-separated CRM company ids")
    e.add_argument("--also", action="append", default=[], help="PERSON_ID=COMPANY_ID: read this person's mail for that company")
    e.add_argument("--top", type=int, default=20)
    e.add_argument("--skip-reviewed", action="store_true", help="leave out companies in earlier runs")
    e.add_argument("--workers", type=int, default=1, help="model calls at once")
    a = sub.add_parser("apply")
    a.add_argument("run")
    a.add_argument("--only", help="comma-separated company ids to load")
    a.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    conn = psycopg2.connect(args.dsn)
    try:
        return extract(conn, args) if args.command == "extract" else apply(conn, args)
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
