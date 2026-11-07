#!/usr/bin/env python3
"""Relay voice study: learn how the owner writes from his sent mail, so Relay drafts sound like him from the first try.

  relay_voice_study.py extract              # every email he sent, cleaned, with the message it answered (no model)
  relay_voice_study.py tag [--workers 4]    # situation and move for each email (batched model calls; resumable)
  relay_voice_study.py synthesize           # writing guide, one card per situation, the example bank (model)
  relay_voice_study.py eval [--n 30]        # held-out replies drafted with today's prompt and with the voice; scored
  relay_voice_study.py publish [--activate] # write the voice as a new version into relay_voice* (CRM database)
  relay_voice_study.py render               # write alex-voice.md (read by every other drafter) from the active voice and rules

Work files live in --work (default /srv/rebattery-data/relay-voice/<owner>), never in the repository: they hold mail.
Read-only on mail. publish is the only step that writes to the database, and only to the relay_voice tables.
"""

from __future__ import annotations

import argparse
import collections
import concurrent.futures
import datetime as dt
import json
import random
import re
import statistics
import sys
from pathlib import Path
from typing import Any

import psycopg2
import psycopg2.extras

sys.path.insert(0, str(Path(__file__).resolve().parent))
import relay_scan as rs  # noqa: E402  (cleaning, contact types, the Hermes model call)

DEFAULT_DSN = rs.DEFAULT_DSN
WORK_ROOT = Path("/srv/rebattery-data/relay-voice")
TRIAGE_DIR = Path("/root/.hermes/workspace/gmail-unified-triage")
# Every other drafter (writing-emails skill, Gmail triage, email sprint) reads this file; `render` writes it from the active voice
# and the approved rules, so Relay's database is the one source of how Alex writes.
VOICE_FILE = Path("/root/.hermes/workspace/cron/gmail-voice-audit/alex-voice.md")
IDENTITIES = {"alex", "supply", "hello"}  # mailboxes Alex writes from himself; support@/ari@/sean@ are other voices
HOLDOUT = 40  # newest replies kept out of the example bank, for the eval

SITUATIONS = rs.SITUATIONS
MOVES = ["fact", "question", "offer", "call", "listing", "defer", "decline", "thanks", "intro", "chase", "files"]

MONEY = re.compile(r"(?:[£€$]\s?\d[\d,.]*\d(?:\s?(?:k|m|bn)\b)?|[£€$]\s?\d|\b\d[\d,.]*(?:k|m)?\s?(?:gbp|eur|usd|euros?|pounds?)\b)", re.I)
PHONE = re.compile(r"(?:\+|\b00)\d[\d\s().-]{7,}\d")
EMAIL = re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b")
URL = re.compile(r"https?://\S+")
GREETING = re.compile(r"^\s*(hi|hey|hello|dear|morning|good (morning|afternoon|evening))\b[^\n]{0,60}[,!]?\s*$", re.I | re.M)
SIGNOFF = re.compile(r"\n\s*(best( wishes| regards)?|thanks( again| so much)?|thank you|many thanks|cheers|regards|kind regards|speak soon|all the best|warm regards|have a (great|good) [a-z]+)\s*[,!.]?\s*\n+\s*alex\b", re.I)


# ---------- helpers ----------

def owner_dir(work: Path | None, owner: str) -> Path:
    path = work or WORK_ROOT / re.sub(r"[^a-z0-9]+", "_", owner.lower())
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    return path


def read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").split("\n") if line.strip()]  # not splitlines: mail holds U+2028


def write_jsonl(path: Path, rows: list[dict]) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text("".join(json.dumps(r, ensure_ascii=False, default=str) + "\n" for r in rows), encoding="utf-8")
    tmp.chmod(0o600)
    tmp.replace(path)


def write_private(path: Path, text: str) -> None:
    path.write_text(text, encoding="utf-8")
    path.chmod(0o600)


def words(text: str) -> int:
    return len(re.findall(r"\b\w[\w'’-]*\b", text or ""))


def mask(text: str) -> str:
    """Examples teach style, not facts: old prices, phone numbers and addresses must never reach a new email."""
    text = URL.sub("[link]", text or "")
    text = EMAIL.sub("[email]", text)
    text = PHONE.sub("[phone]", text)
    return MONEY.sub("[amount]", text)


def body_of(text: str) -> str:
    """The message without the greeting line and the sign-off, for length and rhythm."""
    text = SIGNOFF.split(text)[0] if SIGNOFF.search(text) else text
    return GREETING.sub("", text, count=1).strip()


def signoff_of(text: str) -> str:
    m = SIGNOFF.search(text + "\n")
    return m.group(1).strip().lower() if m else ("alex only" if re.search(r"\n\s*alex\s*$", text, re.I) else "none")


def greeting_of(text: str) -> str:
    first = (text or "").strip().split("\n", 1)[0]
    m = re.match(r"\s*(hi|hey|hello|dear|morning|good morning|good afternoon)\b", first, re.I)
    return m.group(1).lower() if m else "none"


def unwrap(text: str) -> str:
    """Rejoin lines that Gmail's plain-text copy hard-wrapped at ~72 characters; short lines (greeting, sign-off) stay."""
    paragraphs = []
    for para in re.split(r"\n\s*\n", text or ""):
        lines = para.split("\n")
        merged = [lines[0]]
        for line in lines[1:]:
            if len(merged[-1]) >= 60 and line.strip() and not re.match(r"\s*([-*•]|\d+[.)])\s", line):
                merged[-1] = merged[-1].rstrip() + " " + line.strip()
            else:
                merged.append(line)
        paragraphs.append("\n".join(merged))
    return "\n\n".join(paragraphs).strip()


def own(email: str | None) -> bool:
    return rs.is_own(email)


# ---------- extract ----------

def extract(args) -> None:
    out = owner_dir(args.work, args.owner)
    conn = psycopg2.connect(args.dsn)
    conn.set_session(readonly=True)
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    owner_id = rs.load_owner(cur, args.owner)
    relay_written = relay_draft_ids(cur)
    cur.execute(
        """select m.id, m.thread_id, m.direction, m.identity_key, m.from_email, coalesce(m.to_emails,'{}') as to_emails,
                  coalesce(m.cc_emails,'{}') as cc_emails, m.subject, m.body_text, m.body_html, m.labels, m.state, m.campaign_id, m.purpose,
                  coalesce(m.sent_at, m.accepted_at, m.created_at) as at, p.full_name as from_name
             from mail_message m left join crm_people p on p.id = m.from_person_id
            where m.mailbox_owner_id = %s and m.thread_id is not null and m.state in ('received', 'accepted')
              and m.campaign_id is null and coalesce(m.purpose, '') <> 'marketing'
            order by m.thread_id, at""", (owner_id,))
    threads: dict[str, list[dict]] = collections.defaultdict(list)
    for r in cur.fetchall():
        threads[r["thread_id"]].append(dict(r))
    emails = set()
    for msgs in threads.values():
        for m in msgs:
            for e in (m["to_emails"] or []) + [m["from_email"] or ""]:
                emails.add(rs.email_of(e))
    people = rs.load_people(cur, sorted(e for e in emails if e))
    companies = rs.load_companies_by_domain(cur, sorted({rs.domain_of(e) for e in emails} - rs.FREEMAIL - {""}))
    cur.execute("select distinct thread_id from crm_bulk_thread_links where channel = 'mail' and state in ('confirmed', 'proposed')")
    deal_threads = {r["thread_id"] for r in cur.fetchall()}
    conn.close()

    rows, seen_text = [], collections.Counter()
    for tid, msgs in threads.items():
        for i, m in enumerate(msgs):
            if m["direction"] != "outbound" or (m["identity_key"] or "alex") not in IDENTITIES or m["id"] in relay_written:
                continue  # Relay's own drafts would teach the voice its own habits
            external = [rs.email_of(e) for e in (m["to_emails"] or []) + (m["cc_emails"] or []) if not own(e)]
            subject = m["subject"] or ""
            if not external or rs.CALENDAR_SUBJECT.match(subject) or re.match(r"^\s*(fwd?|fw)\s*:", subject, re.I):
                continue
            text = unwrap(rs.clean_text(m["body_html"], m["body_text"]))
            if words(text) < 3 or "unsubscribe" in text.lower():
                continue
            key = re.sub(r"\W+", " ", body_of(text).lower()).strip()[:400]
            seen_text[key] += 1
            if seen_text[key] > 2:  # a pasted template counts twice at most
                continue
            earlier = [x for x in msgs[:i] if x["at"] <= m["at"]]
            prior = earlier[-1] if earlier else None
            inbound = next((x for x in reversed(earlier) if x["direction"] == "inbound" and not own(x["from_email"])
                            and not rs.is_automated(x["from_email"], x["subject"])), None)
            if prior is None:
                kind = "opener"
            elif prior["direction"] == "inbound" and inbound is prior:
                kind = "reply"
            elif prior["direction"] == "outbound":
                kind = "chase"  # he wrote the message before this one too: a nudge or a follow-on
            else:
                kind = "reply"
            to = external[0]
            person = people.get(to) or {}
            company = companies.get(rs.domain_of(to)) or {}
            rows.append({
                "id": m["id"], "thread_id": tid, "at": m["at"].isoformat(), "kind": kind, "identity": m["identity_key"] or "alex",
                "to": to, "to_name": person.get("full_name"), "company": person.get("company") or company.get("name") or rs.company_from_domain(to),
                "contact_type": rs.purpose_type(person.get("purpose")) or rs.purpose_type(company.get("purpose")),
                "deal": tid in deal_threads, "subject": subject, "position": i, "thread_len": len(msgs),
                "text": text, "words": words(body_of(text)),
                "inbound": {"from": inbound["from_name"] or inbound["from_email"], "at": inbound["at"].isoformat(), "subject": inbound["subject"],
                            "text": unwrap(rs.clean_text(inbound["body_html"], inbound["body_text"]))[:3000],
                            "latency_minutes": round((m["at"] - inbound["at"]).total_seconds() / 60)} if inbound and kind == "reply" else None,
            })
    rows.sort(key=lambda r: r["at"])
    write_jsonl(out / "corpus.jsonl", rows)
    stats = compute_stats(rows)
    write_private(out / "stats.json", json.dumps(stats, indent=2, ensure_ascii=False))
    print(json.dumps({"emails": len(rows), "by_kind": collections.Counter(r["kind"] for r in rows), "work": str(out),
                      "first": rows[0]["at"] if rows else None, "last": rows[-1]["at"] if rows else None}, default=str))


def compute_stats(rows: list[dict], by: str | None = None) -> dict[str, Any]:
    """Exact numbers the guide quotes: length, greeting, sign-off, questions, rhythm, reply speed."""
    def block(rs_: list[dict]) -> dict[str, Any]:
        if not rs_:
            return {}
        w = sorted(r["words"] for r in rs_)
        q = lambda p: w[min(len(w) - 1, int(p * len(w)))]
        bodies = [body_of(r["text"]) for r in rs_]
        paras = [len([p for p in re.split(r"\n\s*\n", b) if p.strip()]) for b in bodies]
        lat = [r["inbound"]["latency_minutes"] for r in rs_ if r.get("inbound") and r["inbound"]["latency_minutes"] >= 0]
        share = lambda n: round(100 * n / len(rs_))
        return {
            "n": len(rs_), "words_p25": q(.25), "words_median": q(.5), "words_p75": q(.75), "words_p90": q(.9),
            "paragraphs_median": statistics.median(paras),
            "greeting": dict(collections.Counter(greeting_of(r["text"]) for r in rs_).most_common(5)),
            "signoff": dict(collections.Counter(signoff_of(r["text"]) for r in rs_).most_common(8)),
            "asks_question_pct": share(sum("?" in b for b in bodies)),
            "exclamation_pct": share(sum("!" in b for b in bodies)),
            "spaced_hyphen_pct": share(sum(" - " in b for b in bodies)),
            "em_dash_pct": share(sum("—" in b for b in bodies)),
            "bullets_pct": share(sum(bool(re.search(r"^\s*([-*•]|\d+[.)])\s", b, re.M)) for b in bodies)),
            "apology_pct": share(sum(bool(re.search(r"\b(sorry|apologies)\b", b, re.I)) for b in bodies)),
            "calendly_pct": share(sum("calendly" in r["text"].lower() for r in rs_)),
            "reply_minutes_median": statistics.median(lat) if lat else None,
        }
    out = {"all": block(rows), "by_kind": {k: block([r for r in rows if r["kind"] == k]) for k in ("reply", "chase", "opener")},
           "by_identity": {k: block([r for r in rows if r["identity"] == k]) for k in sorted({r["identity"] for r in rows})},
           "by_contact_type": {k: block([r for r in rows if (r["contact_type"] or "unknown") == k]) for k in sorted({r["contact_type"] or "unknown" for r in rows})}}
    if by:
        out[f"by_{by}"] = {k: block([r for r in rows if r.get(by) == k]) for k in sorted({r.get(by) for r in rows if r.get(by)})}
    return out


# ---------- tag ----------

TAG_INSTRUCTIONS = f"""You label emails Alex Polglase (founder of ReBattery, a UK marketplace and broker for used EV and storage batteries) sent.
For each item you get what the other person last wrote (may be empty) and Alex's email. Reply with ONLY a JSON array, one object per item:
{{"id": "<item id>", "situation": "<one key>", "moves": ["<1-3 keys>"], "exemplar": 0-3, "why": "<6-12 words: what Alex did>"}}
situation keys: {json.dumps(SITUATIONS)}
moves keys: fact (gave the answer, price, slot or detail), question (asked for something), offer (made or proposed a deal), call (proposed a call),
listing (pushed towards listing on ReBattery), defer (will come back later), decline, thanks, intro, chase, files (sent or asked for files).
exemplar: how good this email is as a model of Alex's voice for this situation: 3 complete, natural and typical; 2 good; 1 usable but thin
or odd; 0 not useful (one-liner with no content, mostly a forward, automated, or written for someone else)."""


def tag_batch(items: list[dict]) -> list[dict]:
    payload = [{"id": r["id"], "other_person_wrote": (r["inbound"] or {}).get("text", "")[:500], "subject": r["subject"][:120],
                "kind": r["kind"], "alex_wrote": r["text"][:900]} for r in items]
    raw = rs.run_hermes(TAG_INSTRUCTIONS + "\n\n## Items\n" + json.dumps(payload, ensure_ascii=False))
    start, end = raw.find("["), raw.rfind("]")
    found = {}
    for obj in json.loads(raw[start:end + 1]) if start != -1 else []:
        if isinstance(obj, dict) and obj.get("id") and obj.get("situation") in SITUATIONS:
            found[str(obj["id"])] = {"situation": obj["situation"], "moves": [m for m in obj.get("moves") or [] if m in MOVES][:3],
                                     "exemplar": int(obj.get("exemplar") or 0) if str(obj.get("exemplar", "0")).isdigit() else 0,
                                     "why": str(obj.get("why") or "")[:120]}
    return [{"id": r["id"], **found[r["id"]]} for r in items if r["id"] in found]


def tag(args) -> None:
    out = owner_dir(args.work, args.owner)
    corpus = read_jsonl(out / "corpus.jsonl")
    done = {t["id"]: t for t in read_jsonl(out / "tags.jsonl")}
    todo = [r for r in corpus if r["id"] not in done]
    batches = [todo[i:i + args.batch] for i in range(0, len(todo), args.batch)][: args.max_batches or None]
    errors, calls = [], 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(tag_batch, b): b for b in batches}
        for future in concurrent.futures.as_completed(futures):
            calls += 1
            try:
                for t in future.result():
                    done[t["id"]] = t
            except Exception as exc:  # a failed batch is retried on the next run
                errors.append(str(exc)[:200])
            if calls % 5 == 0:
                write_jsonl(out / "tags.jsonl", list(done.values()))
    write_jsonl(out / "tags.jsonl", list(done.values()))
    print(json.dumps({"tagged": len(done), "of": len(corpus), "calls": calls, "errors": errors[:5], "error_count": len(errors),
                      "situations": collections.Counter(t["situation"] for t in done.values()).most_common()}))


# ---------- synthesize ----------

CARD_INSTRUCTIONS = """You write one card of Alex Polglase's email playbook: how he handles one situation. Alex is the founder of ReBattery
(UK marketplace and broker for used EV and storage batteries). The card is read by the model that drafts his replies, so it must be
concrete and usable, not a description of a personality. Base it ONLY on the real emails and numbers given. British English, no em dashes.
Reply with ONLY JSON: {"card": "<markdown, 120-200 words: **When** (one line), **What Alex is after**, **His usual move** (what he does,
in order), **Shape** (length range in words, paragraphs, greeting and sign-off habits for this situation, from the numbers), **Lines he
uses** (2-4 short phrases quoted from the emails, facts removed), **Never** (2-3 things he avoids here)>",
"best": ["<8-12 ids of the emails that best show this, varied in contact and length>"]}"""

GUIDE_INSTRUCTIONS = """You write the writing guide that Relay, Alex Polglase's email assistant, follows for every email it drafts as him.
Alex is the founder of ReBattery (UK marketplace and broker for used EV and storage batteries). Sources: measured numbers from his sent
mail, his earlier voice notes, his approved commercial lines and playbooks, the rules learned from his edits, and real emails.
Alex is brief, and drafts so far have padded: make it explicit that a draft says what his note says and stops, with no recap
of their message, no added context, and no extra offers, questions or pleasantries the note does not ask for. When in doubt, shorter.
His own Relay writing rules come first. After them, measured numbers and real emails win over the notes when they disagree.
Keep every approved commercial line word for word.
Write in second person to the drafting model ("Open with..."). Concrete defaults with numbers, not adjectives. British English, no em dashes.
Sections, in this order: ## Who you are writing as (3 lines) ## Defaults (greeting, length by kind with the real word ranges, paragraphing,
punctuation habits, sign-off with real frequencies) ## How Alex engages (his moves: answers with the fact, asks one thing, pushes sellers to
list, proposes a call, how he chases, how he says no) ## Commercial lines (approved, verbatim) ## Never.
650-850 words. Reply with ONLY the markdown guide."""


def sample_for(rows: list[dict], n: int, seed: int = 7) -> list[dict]:
    """Best exemplars first, newer weighted up, varied contacts."""
    rng = random.Random(seed)
    rows = sorted(rows, key=lambda r: (-r.get("exemplar", 0), -dt.datetime.fromisoformat(r["at"]).timestamp() + rng.random() * 3e7))
    seen, picked = collections.Counter(), []
    for r in rows:
        if seen[r["to"]] >= 2:
            continue
        seen[r["to"]] += 1
        picked.append(r)
        if len(picked) >= n:
            break
    return picked


def representative(pool: list[dict], n: int, prefer: list[str] = ()) -> list[dict]:
    """Examples that look like his usual email here, not his longest: closest to the median length first (the model's picks
    first when they are in range), newer and better-rated breaking ties, at most two per recipient."""
    if not pool:
        return []
    w = sorted(r["words"] for r in pool)
    lo, mid, hi = w[len(w) // 4], w[len(w) // 2], w[min(len(w) - 1, 3 * len(w) // 4)]
    in_range = [r for r in pool if lo <= r["words"] <= hi]
    order = {i: k for k, i in enumerate(prefer)}
    ranked = sorted(in_range, key=lambda r: (r["id"] not in order, order.get(r["id"], 0), abs(r["words"] - mid) // 10,
                                             -r.get("exemplar", 0), -dt.datetime.fromisoformat(r["at"]).timestamp()))
    seen, picked = collections.Counter(), []
    for r in ranked:
        if seen[r["to"]] < 2:
            seen[r["to"]] += 1
            picked.append(r)
        if len(picked) >= n:
            break
    return picked


def length_line(rows: list[dict]) -> str:
    w = sorted(r["words"] for r in rows)
    if not w:
        return ""
    return f"\n\n**Target length**: about {w[len(w) // 2]} words, not counting greeting and sign-off. His emails here usually run {w[len(w) // 4]} to {w[3 * len(w) // 4]}."


def example_view(r: dict, chars: int = 900) -> dict:
    return {"id": r["id"], "kind": r["kind"], "contact_type": r.get("contact_type"), "when": r["at"][:10], "words": r["words"],
            "they_wrote": ((r.get("inbound") or {}).get("text") or "")[:500], "alex_wrote": r["text"][:chars]}


def joined(out: Path) -> tuple[list[dict], list[dict]]:
    corpus = read_jsonl(out / "corpus.jsonl")
    tags = {t["id"]: t for t in read_jsonl(out / "tags.jsonl")}
    rows = [{**r, **tags[r["id"]]} for r in corpus if r["id"] in tags]
    replies = sorted([r for r in rows if r["kind"] == "reply" and r.get("inbound") and r["words"] >= 8], key=lambda r: r["at"])
    holdout = replies[-HOLDOUT:]
    held = {r["id"] for r in holdout}
    return [r for r in rows if r["id"] not in held], holdout


def synthesize(args) -> None:
    out = owner_dir(args.work, args.owner)
    rows, holdout = joined(out)
    stats = compute_stats(rows, by="situation")
    write_private(out / "stats.json", json.dumps(stats, indent=2, ensure_ascii=False))
    by_sit = collections.defaultdict(list)
    for r in rows:
        by_sit[r["situation"]].append(r)
    playbooks = (TRIAGE_DIR / "email-playbooks.md").read_text(encoding="utf-8") if (TRIAGE_DIR / "email-playbooks.md").exists() else ""

    def card(sit: str) -> tuple[str, dict]:
        pool = [r for r in by_sit[sit] if r.get("exemplar", 0) >= 1]
        shown = sample_for(pool, 40)
        prompt = (CARD_INSTRUCTIONS + f"\n\n## Situation: {sit} ({SITUATIONS[sit]})\n## Numbers for this situation\n"
                  + json.dumps(stats["by_situation"].get(sit, {})) + "\n## His playbooks (for context)\n" + playbooks[:4000]
                  + "\n## Real emails\n" + json.dumps([example_view(r) for r in shown], ensure_ascii=False))
        raw = rs.run_hermes(prompt)
        parsed = json.loads(raw[raw.find("{"):raw.rfind("}") + 1])
        ids = {r["id"] for r in pool}
        return sit, {"card": str(parsed.get("card") or "").replace("—", ","), "best": [i for i in parsed.get("best") or [] if i in ids][:12]}

    cards = json.loads((out / "cards.json").read_text()) if (out / "cards.json").exists() else {}
    wanted = [s for s in SITUATIONS if s not in cards and len(by_sit[s]) >= 5]
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        for future in concurrent.futures.as_completed([pool.submit(card, s) for s in wanted]):
            try:
                sit, value = future.result()
                cards[sit] = value
                write_private(out / "cards.json", json.dumps(cards, indent=2, ensure_ascii=False))
            except Exception as exc:
                print(json.dumps({"card_error": str(exc)[:200]}), file=sys.stderr)

    sources = {
        "the writing guide in use now": (active_voice(args) or {}).get("guide", ""),
        "approved facts and commercial lines": (TRIAGE_DIR / "alex-context.md").read_text(encoding="utf-8") if (TRIAGE_DIR / "alex-context.md").exists() else "",
        "playbooks": playbooks,
        "his own Relay writing rules (he wrote these; they win over everything else)": "\n".join(f"- {r}" for r in owner_rules(args)),
        "rules learned from his edits (he approved these)": "\n".join(f"- {r}" for r in owner_rules(args, source="learned")),
    }
    spread = [r for s in SITUATIONS for r in sample_for([x for x in by_sit[s] if x.get("exemplar", 0) >= 2], 3)]
    prompt = (GUIDE_INSTRUCTIONS + "\n\n## Measured numbers\n" + json.dumps({k: stats[k] for k in ("all", "by_kind", "by_identity", "by_contact_type")})
              + "".join(f"\n\n## {name}\n{text}" for name, text in sources.items() if text)
              + "\n\n## Situation cards\n" + "\n\n".join(f"### {s}\n{c['card']}" for s, c in cards.items())
              + "\n\n## Real emails\n" + json.dumps([example_view(r, 700) for r in spread], ensure_ascii=False))
    guide = rs.run_hermes(prompt).strip().replace("—", ",")
    guide = guide[guide.find("##"):] if "##" in guide else guide
    write_private(out / "guide.md", guide)
    bank = []
    for sit, c in cards.items():
        c["card"] = c["card"].split("\n\n**Target length**")[0] + length_line(by_sit[sit])
        chosen = representative([r for r in by_sit[sit] if r.get("exemplar", 0) >= 1], 12, prefer=c["best"])
        for r in chosen:
            bank.append({"situation": sit, "contact_type": r.get("contact_type"), "identity": r["identity"], "kind": r["kind"],
                         "inbound": mask(((r.get("inbound") or {}).get("text") or "")[:700]), "reply": mask(r["text"][:1500]),
                         "words": r["words"], "sent_at": r["at"], "mail_message_id": r["id"], "thread_id": r["thread_id"], "why": r.get("why", "")})
    write_jsonl(out / "examples.jsonl", bank)
    write_private(out / "cards.json", json.dumps(cards, indent=2, ensure_ascii=False))
    print(json.dumps({"cards": len(cards), "guide_words": words(guide), "examples": len(bank), "holdout": len(holdout)}))


# ---------- the drafting prompt (mirrors apps/web/lib/relay.ts) ----------

DEFAULT_RULES = ["Two to four short lines. Warm and direct.", "British English. No em dashes.",
                 "Never offer a price to a dismantler or supplier: ask for theirs.", "Every number must come from the thread or the deal."]


GREETING_PLAIN = '- Greet by first name ("Hi Mark,"), sign off "Best,\\nAlex". Do not add a signature block; it is added automatically.'
GREETING_VOICE = ('- Greet by first name ("Hi Mark,"). Sign off the way "How Alex writes" describes, with "Alex" on its own line. '
                  'Do not add a signature block; it is added automatically.')


def draft_system(rules: list[str], guide: str | None) -> str:
    """relay.ts DRAFT_SYSTEM, with the voice guide in front of the rules when there is one."""
    voice = f"\nHow Alex writes (follow this closely; it is learned from thousands of his emails):\n{guide}\n" if guide else ""
    return (f"""You are Relay, drafting emails for Alex Polglase, founder of ReBattery (a UK marketplace and broker for used EV and storage batteries).
Write exactly what Alex asked for in his note, in his voice.{voice} Follow these writing rules strictly:
""" + "\n".join(f"- {r}" for r in rules) + """
- Never invent facts: prices, quantities, dates, tests, partners, logistics or availability must come from the thread, the deal or Alex's note. Use a [BLANK] if something is missing.
- Nothing is attached to this draft. Never write that something is attached, enclosed or included as a file. If a file is needed, say you will send it, and add a to-do.
""" + (GREETING_VOICE if guide else GREETING_PLAIN) + """
- No em dashes. British English.
Return ONLY JSON: {"subject": "Re: …", "body": "the reply text", "follow_ons": [], "todos": [], "log": []}""")


def voice_examples_block(card: str | None, examples: list[dict]) -> str:
    if not card and not examples:
        return ""
    parts = ["How Alex handles this kind of email:\n" + card] if card else []
    if examples:
        parts.append("How Alex answered similar emails (style only: the facts, names and numbers in them are old and must not be reused):\n"
                     + "\n\n".join(f"They wrote: {e['inbound'][:400]}\nAlex replied:\n{e['reply']}" for e in examples))
    return "\n\n".join(parts) + "\n\n"


def pick_examples(bank: list[dict], situation: str | None, contact_type: str | None, text: str, k: int = 3) -> list[dict]:
    """Same situation, same kind of contact preferred, then most shared words with their email, then newest."""
    wanted = set(re.findall(r"[a-z]{4,}", (text or "").lower()))
    pool = [e for e in bank if e["situation"] == situation] or [e for e in bank if contact_type and e["contact_type"] == contact_type]
    return sorted(pool, key=lambda e: (e["contact_type"] == contact_type, len(wanted & set(re.findall(r"[a-z]{4,}", e["inbound"].lower()))), e["sent_at"]), reverse=True)[:k]


# ---------- eval ----------

NOTE_INSTRUCTIONS = """For each item, write the note Alex would have typed into his email assistant before this reply: terse, lower-case,
5-18 words, only what he decided to say (facts, numbers, the ask), no style words. Example: "thank him, offer 38 per kwh, ask volumes and location".
Reply with ONLY a JSON array: [{"id": "...", "note": "..."}]"""

JUDGE_INSTRUCTIONS = """You compare two drafted replies with the reply Alex actually sent. For each item decide which draft reads more like
Alex wrote it: wording, length, rhythm, greeting and sign-off, how direct it is. Ignore which facts each includes. Reply with ONLY a JSON array:
[{"id": "...", "closer": "A" | "B" | "tie", "why": "<8 words>"}]"""


def eval_(args) -> None:
    out = owner_dir(args.work, args.owner)
    _, holdout = joined(out)
    holdout = holdout[-args.n:]
    guide = (out / "guide.md").read_text(encoding="utf-8")
    cards = json.loads((out / "cards.json").read_text())
    bank = read_jsonl(out / "examples.jsonl")
    rules = owner_rules(args, source=None) or DEFAULT_RULES
    current = active_voice(args) if args.baseline == "active" else None
    notes = {}
    for i in range(0, len(holdout), 10):
        chunk = holdout[i:i + 10]
        raw = rs.run_hermes(NOTE_INSTRUCTIONS + "\n\n" + json.dumps([{"id": r["id"], "they_wrote": r["inbound"]["text"][:800], "alex_replied": r["text"][:1200]} for r in chunk], ensure_ascii=False))
        for obj in json.loads(raw[raw.find("["):raw.rfind("]") + 1]):
            notes[obj["id"]] = obj["note"]

    def prompt_for(r: dict) -> str:
        return (f"Alex's note (what he wants to say):\n{notes[r['id']]}\n\nThread (oldest first):\n--- From {r['inbound']['from']} · {r['inbound']['at'][:16]}\n"
                f"Subject: {r['inbound']['subject'] or ''}\n{r['inbound']['text'][:3000]}\n\nReply to: {r['inbound']['from']}")

    def draft(r: dict, arm: str) -> str:
        if arm == "before" and current:
            ex = pick_examples(current["bank"], r["situation"], r.get("contact_type"), r["inbound"]["text"])
            system, user = draft_system(rules, current["guide"]), voice_examples_block(current["cards"].get(r["situation"]), ex) + prompt_for(r)
        elif arm == "before":
            system, user = draft_system(rules, None), prompt_for(r)
        else:
            ex = pick_examples(bank, r["situation"], r.get("contact_type"), r["inbound"]["text"])
            system, user = draft_system(rules, guide), voice_examples_block((cards.get(r["situation"]) or {}).get("card"), ex) + prompt_for(r)
        raw = rs.run_hermes(system + "\n\n" + user)
        try:
            return str(json.loads(raw[raw.find("{"):raw.rfind("}") + 1]).get("body") or "").strip()
        except Exception:
            return ""

    jobs = [(r, arm) for r in holdout if r["id"] in notes for arm in ("before", "after")]
    drafts: dict[tuple[str, str], str] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        for (r, arm), body in zip(jobs, pool.map(lambda j: draft(*j), jobs)):
            drafts[(r["id"], arm)] = body
    sim = _similarity()
    rows, verdicts = [], {}
    rng = random.Random(11)
    flips = {}
    for i in range(0, len(holdout), 8):
        chunk = [r for r in holdout[i:i + 8] if drafts.get((r["id"], "before")) and drafts.get((r["id"], "after"))]
        items = []
        for r in chunk:
            flip = rng.random() < 0.5
            flips[r["id"]] = flip
            a, b = (drafts[(r["id"], "after")], drafts[(r["id"], "before")]) if flip else (drafts[(r["id"], "before")], drafts[(r["id"], "after")])
            items.append({"id": r["id"], "alex_actual": r["text"][:1200], "A": a[:1200], "B": b[:1200]})
        if items:
            raw = rs.run_hermes(JUDGE_INSTRUCTIONS + "\n\n" + json.dumps(items, ensure_ascii=False))
            for obj in json.loads(raw[raw.find("["):raw.rfind("]") + 1]):
                pick = obj.get("closer")
                verdicts[obj["id"]] = "tie" if pick == "tie" else ("after" if (pick == "A") == flips.get(obj["id"], False) else "before")
    for r in holdout:
        before, after = drafts.get((r["id"], "before"), ""), drafts.get((r["id"], "after"), "")
        if not before or not after:
            continue
        rows.append({"id": r["id"], "situation": r["situation"], "note": notes.get(r["id"]), "actual_words": r["words"],
                     "before_words": words(body_of(before)), "after_words": words(body_of(after)),
                     "before_similarity": round(sim(before, r["text"]), 3), "after_similarity": round(sim(after, r["text"]), 3),
                     "judge": verdicts.get(r["id"]), "actual": r["text"], "before": before, "after": after})
    n = len(rows)
    med = lambda k: statistics.median(x[k] for x in rows) if rows else None
    summary = {"n": n, "judge_after_wins": sum(x["judge"] == "after" for x in rows), "judge_before_wins": sum(x["judge"] == "before" for x in rows),
               "ties": sum(x["judge"] == "tie" for x in rows), "similarity_before_median": med("before_similarity"), "similarity_after_median": med("after_similarity"),
               "words_actual_median": med("actual_words"), "words_before_median": med("before_words"), "words_after_median": med("after_words"),
               "length_error_before": statistics.median(abs(x["before_words"] - x["actual_words"]) for x in rows) if rows else None,
               "length_error_after": statistics.median(abs(x["after_words"] - x["actual_words"]) for x in rows) if rows else None}
    summary["baseline"] = f"voice v{current['version']}" if current else "no voice"
    write_jsonl(out / "eval.jsonl", rows)
    write_private(out / "eval-summary.json", json.dumps(summary, indent=2))
    print(json.dumps(summary))


def owner_rules(args, source: str | None = "alex") -> list[str]:
    """Rules in force for the owner: his own (source 'alex'), the learned ones he approved ('learned'), or both (None)."""
    conn = psycopg2.connect(args.dsn)
    conn.set_session(readonly=True)
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("""select r.text from relay_rule r join crm_users u on u.id = r.owner_id
                       where lower(u.email) = lower(%s) and r.state = 'active' and (%s::text is null or r.source = %s)
                       order by r.source, r.position, r.created_at""", (args.owner, source, source))
        return [r["text"] for r in cur.fetchall()]
    finally:
        conn.close()


def active_voice(args) -> dict | None:
    """The voice Relay uses now: guide, cards by situation and the example bank."""
    conn = psycopg2.connect(args.dsn)
    conn.set_session(readonly=True)
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("""select v.id, v.version, v.guide from relay_voice v join crm_users u on u.id = v.owner_id
                       where lower(u.email) = lower(%s) and v.active""", (args.owner,))
        voice = cur.fetchone()
        if not voice:
            return None
        cur.execute("select situation, card from relay_voice_situation where voice_id = %s", (voice["id"],))
        cards = {r["situation"]: r["card"] for r in cur.fetchall()}
        cur.execute("select situation, contact_type, inbound, reply, sent_at::text as sent_at from relay_voice_example where voice_id = %s", (voice["id"],))
        return {"version": voice["version"], "guide": voice["guide"], "cards": cards, "bank": [dict(r) for r in cur.fetchall()]}
    finally:
        conn.close()


def relay_draft_ids(cur) -> set[str]:
    if not rs.table_exists(cur, "relay_draft"):
        return set()
    cur.execute("select mail_message_id from relay_draft where mail_message_id is not null")
    return {r["mail_message_id"] for r in cur.fetchall()}


RENDER_HEADER = """# How Alex writes

Generated from Relay: the active writing style (version {version}) and the rules Alex has approved. Do not edit this file;
change rules on Relay's Rules page (crm.rebattery.io ~crm/relay). Rebuilt within ten minutes of any change.
"""


def render_text(voice: dict, own: list[str], learned: list[str]) -> str:
    parts = [RENDER_HEADER.format(version=voice["version"]).strip(), voice["guide"].strip()]
    if own:
        parts.append("## Alex's own rules (always follow)\n" + "\n".join(f"- {r}" for r in own))
    if learned:
        parts.append("## Learned from his edits (approved)\n" + "\n".join(f"- {r}" for r in learned))
    return "\n\n".join(parts) + "\n"


def render(args) -> None:
    """Write alex-voice.md when the active voice or the approved rules changed. Nothing is written without an active voice."""
    voice = active_voice(args)
    if not voice:
        print(json.dumps({"rendered": False, "reason": "no active voice"}))
        return
    text = render_text(voice, owner_rules(args, "alex"), owner_rules(args, "learned"))
    path = args.render_to
    if path.exists() and path.read_text(encoding="utf-8") == text:
        print(json.dumps({"rendered": False, "reason": "unchanged"}))
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.chmod(0o600)
    tmp.replace(path)
    print(json.dumps({"rendered": True, "path": str(path), "version": voice["version"], "words": words(text)}))


def _similarity():
    try:
        if str(rs.TRIAGE_APP_SRC) not in sys.path:
            sys.path.insert(0, str(rs.TRIAGE_APP_SRC))
        from gmail_email_management.outcomes import similarity  # type: ignore
        return lambda a, b: similarity(body_of(a), body_of(b)) or 0.0
    except Exception:
        import difflib
        return lambda a, b: difflib.SequenceMatcher(None, body_of(a).lower(), body_of(b).lower()).ratio()


# ---------- eval: Relay's drafts before a note ----------

PREDRAFT_JUDGE = """Relay drafts Alex Polglase's email replies before he says anything. For each item you get the thread as Relay saw it
(oldest first, including Alex's own earlier emails), what Alex actually sent next, and what Relay produced: either a draft, or a question
to Alex with options.
Judge each item. Reply with ONLY a JSON array:
[{"id": "...",
  "decision_needed": true|false (Alex's real email made a call only he could make: a price or offer, accepting or setting terms,
     committing to a date, quantity or delivery, a yes or no on a deal; false for acknowledgements, scheduling with given slots,
     passing on information already in the thread, routine chases),
  "rating": "sendable" | "light" | "wrong" | "asked",
     sendable: Alex could send Relay's draft as is; light: small edits; wrong: says something Alex did not mean or misses the point;
     asked: Relay asked a question instead of drafting,
  "asked_right": true|false|null (only when Relay asked: was asking the right call, and do the options cover what Alex did?),
  "invented": true|false (the draft states a fact or event found nowhere in the thread, or promises an action Alex never said he would take),
  "why": "<10 words>"}]"""


def predraft_cases(out: Path, n_replies: int, n_chases: int) -> list[dict]:
    rows, holdout = joined(out)
    banked = {e["mail_message_id"] for e in read_jsonl(out / "examples.jsonl")}
    chases = [r for r in rows if r["kind"] == "chase" and r["words"] >= 6 and r["id"] not in banked][-n_chases:]
    picked = holdout[-n_replies:] + chases
    return [{"id": r["id"], "mail_thread_id": r["thread_id"], "before_message_id": r["id"], "tab": "follow" if r["kind"] == "chase" else "action",
             "counterpart_email": r["to"], "counterpart_name": r.get("to_name"), "situation": r.get("situation"), "contact_type": r.get("contact_type"),
             "_row": r} for r in picked]


def post_internal(url: str, payload: dict, timeout: int = 900) -> dict:
    import urllib.request
    secret = Path("/root/.hermes/workspace/secrets/relay-internal.secret").read_text().strip()
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), method="POST",
                                 headers={"content-type": "application/json", "authorization": f"Bearer {secret}"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def eval_predraft(args) -> None:
    out = owner_dir(args.work, args.owner)
    cases = predraft_cases(out, args.n, args.chases)
    results: dict[str, dict] = {}
    url = args.url.rstrip("/") + "/api/relay/internal/predraft"
    batches = [cases[i:i + 5] for i in range(0, len(cases), 5)]
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        payloads = [{"cases": [{k: v for k, v in c.items() if k != "_row"} for c in b]} for b in batches]
        for reply in pool.map(lambda p: post_internal(url, p), payloads):
            for r in reply.get("results", []):
                results[r["id"]] = r
    items = []
    for c in cases:
        r, res = c["_row"], results.get(c["id"], {})
        s = res.get("suggestion") or {}
        items.append({"id": c["id"], "kind": r["kind"], "situation": r.get("situation"), "thread": (res.get("thread") or "")[-5000:],
                      "they_wrote": ((r.get("inbound") or {}).get("text") or "")[:1200],
                      "alex_actual": r["text"][:1500], "relay_draft": s.get("body") or "", "relay_question": s.get("needs_input"),
                      "error": res.get("error"), "thread_amounts": res.get("amounts") or []})
    verdicts = {}
    for i in range(0, len(items), 5):
        chunk = [{k: v for k, v in it.items() if k in ("id", "thread", "alex_actual", "relay_draft", "relay_question")} for it in items[i:i + 5] if not it["error"]]
        if chunk:
            raw = rs.run_hermes(PREDRAFT_JUDGE + "\n\n" + json.dumps(chunk, ensure_ascii=False))
            for obj in json.loads(raw[raw.find("["):raw.rfind("]") + 1]):
                verdicts[obj["id"]] = obj
    for it in items:
        v = verdicts.get(it["id"], {})
        seen = {a.lower() for a in it["thread_amounts"]}
        it["amounts_not_in_thread"] = [a for a in set(m.group(0).strip() for m in MONEY.finditer(it["relay_draft"])) if normalise_amount(a) not in seen]
        it.update({k: v.get(k) for k in ("decision_needed", "rating", "asked_right", "invented", "why")})
    ok = [it for it in items if not it["error"]]
    drafts = [it for it in ok if it["relay_draft"]]
    asked = [it for it in ok if it["relay_question"]]
    useful = [it for it in ok if it.get("rating") in ("sendable", "light") or (it["relay_question"] and it.get("asked_right"))]
    decisions = [it for it in ok if it.get("decision_needed")]
    invented = [it for it in drafts if it.get("invented") or it["amounts_not_in_thread"]]
    summary = {
        "cases": len(items), "errors": len(items) - len(ok), "drafts": len(drafts), "asked": len(asked),
        "sendable": sum(it.get("rating") == "sendable" for it in ok), "light_edit": sum(it.get("rating") == "light" for it in ok),
        "wrong": sum(it.get("rating") == "wrong" for it in ok), "useful": len(useful), "useful_pct": round(100 * len(useful) / max(1, len(ok))),
        "invented": len(invented), "decision_cases": len(decisions), "asked_when_decision": sum(bool(it["relay_question"]) for it in decisions),
        "asked_without_decision": sum(bool(it["relay_question"]) and not it.get("decision_needed") for it in ok),
        "by_kind": {k: {"n": sum(it["kind"] == k for it in ok), "useful": sum(it["kind"] == k for it in useful)} for k in ("reply", "chase")},
    }
    summary["asked_when_decision_pct"] = round(100 * summary["asked_when_decision"] / max(1, len(decisions)))
    summary["gate"] = summary["useful_pct"] >= 50 and summary["invented"] <= 1 and summary["asked_when_decision_pct"] >= 70
    write_jsonl(out / "predraft-eval.jsonl", items)
    write_private(out / "predraft-eval-summary.json", json.dumps(summary, indent=2))
    print(json.dumps(summary))


OPTIONS_JUDGE = """Relay offers Alex Polglase three one-line replies to choose from before he answers an email ("tap to reply"); one tap
drafts the email from that line. For each item you get the thread as Relay saw it (oldest first, including Alex's own earlier emails),
what Alex actually sent next, and Relay's options in order. Judge whether Alex could have tapped one of them and got the email he wanted.
Same intent counts; wording and detail can differ; a [price] or [date] placeholder he would fill in counts.
Reply with ONLY a JSON array:
[{"id": "...",
  "match": "first" | "other" | "partial" | "none",
     first: the first option is what Alex did; other: a later option is; partial: one option is close but misses a key part of what he did;
     none: no option fits,
  "invented": true|false (an option states a fact or event found nowhere in the thread, or promises an action Alex never said he would take),
  "why": "<10 words>"}]"""


def eval_options(args) -> None:
    """Tap to reply: do Relay's three suggested replies cover what Alex actually did? Replays past emails; stores nothing in the CRM."""
    out = owner_dir(args.work, args.owner)
    cases = predraft_cases(out, args.n, args.chases)
    results: dict[str, dict] = {}
    url = args.url.rstrip("/") + "/api/relay/internal/predraft"
    batches = [cases[i:i + 5] for i in range(0, len(cases), 5)]
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        payloads = [{"mode": "options", "cases": [{k: v for k, v in c.items() if k != "_row"} for c in b]} for b in batches]
        for reply in pool.map(lambda p: post_internal(url, p), payloads):
            for r in reply.get("results", []):
                results[r["id"]] = r
    items = []
    for c in cases:
        r, res = c["_row"], results.get(c["id"], {})
        ask = (res.get("suggestion") or {}).get("needs_input") or {}
        items.append({"id": c["id"], "kind": r["kind"], "situation": r.get("situation"), "thread": (res.get("thread") or "")[-5000:],
                      "alex_actual": r["text"][:1500], "options": ask.get("options") or [], "error": res.get("error")})
    write_jsonl(out / "options-eval.jsonl", items)  # the replays are the slow part: keep them even if judging fails
    verdicts = {}
    for i in range(0, len(items), 5):
        chunk = [{k: v for k, v in it.items() if k in ("id", "thread", "alex_actual", "options")} for it in items[i:i + 5] if not it["error"] and it["options"]]
        for _ in range(2 if chunk else 0):
            raw = rs.run_hermes(OPTIONS_JUDGE + "\n\n" + json.dumps(chunk, ensure_ascii=False))
            try:
                parsed, _end = json.JSONDecoder().raw_decode(raw[raw.find("["):])
                verdicts.update({obj["id"]: obj for obj in parsed if isinstance(obj, dict) and "id" in obj})
                break
            except ValueError:
                continue
    for it in items:
        it.update({k: verdicts.get(it["id"], {}).get(k) for k in ("match", "invented", "why")})
    ok = [it for it in items if not it["error"] and it["options"]]
    count = lambda m: sum(it.get("match") == m for it in ok)
    summary = {
        "cases": len(items), "errors": len(items) - len(ok), "first": count("first"), "other": count("other"), "partial": count("partial"),
        "none": count("none"), "invented": sum(bool(it.get("invented")) for it in ok),
        "by_kind": {k: {"n": sum(it["kind"] == k for it in ok), "covered": sum(it["kind"] == k and it.get("match") in ("first", "other") for it in ok)} for k in ("reply", "chase")},
    }
    summary["covered_pct"] = round(100 * (summary["first"] + summary["other"]) / max(1, len(ok)))
    summary["first_pct"] = round(100 * summary["first"] / max(1, len(ok)))
    write_jsonl(out / "options-eval.jsonl", items)
    write_private(out / "options-eval-summary.json", json.dumps(summary, indent=2))
    print(json.dumps(summary))


def normalise_amount(raw: str) -> str:
    """Mirrors relay-checks normaliseAmount: "£1,500.00" and "£1500" compare equal; "€30k" is €30000."""
    text = raw.strip().rstrip(",.")
    thousands = text.lower().endswith("k")
    digits = re.sub(r"[^\d.]", "", text)
    try:
        value = float(digits) * (1000 if thousands else 1)
    except ValueError:
        return text.lower()
    return f"{text[0]}{round(value, 2):g}".lower() if text and text[0] in "£€$" else text.lower()


# ---------- publish ----------

def publish(args) -> None:
    out = owner_dir(args.work, args.owner)
    guide = (out / "guide.md").read_text(encoding="utf-8")
    cards = json.loads((out / "cards.json").read_text())
    bank = read_jsonl(out / "examples.jsonl")
    stats = json.loads((out / "stats.json").read_text())
    summary = json.loads((out / "eval-summary.json").read_text()) if (out / "eval-summary.json").exists() else None
    conn = psycopg2.connect(args.dsn)
    with conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        owner_id = rs.load_owner(cur, args.owner)
        cur.execute("select coalesce(max(version), 0) + 1 as v from relay_voice where owner_id = %s", (owner_id,))
        version = cur.fetchone()["v"]
        cur.execute("""insert into relay_voice (owner_id, version, guide, stats, eval, source_emails, active) values (%s, %s, %s, %s, %s, %s, false) returning id""",
                    (owner_id, version, guide, psycopg2.extras.Json(stats), psycopg2.extras.Json(summary), stats["all"].get("n")))
        voice_id = cur.fetchone()["id"]
        for sit, c in cards.items():
            cur.execute("insert into relay_voice_situation (voice_id, situation, label, card) values (%s, %s, %s, %s)", (voice_id, sit, SITUATIONS[sit], c["card"]))
        for e in bank:
            cur.execute("""insert into relay_voice_example (voice_id, situation, contact_type, identity, kind, inbound, reply, words, sent_at, mail_message_id, thread_id, why)
                           values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                        (voice_id, e["situation"], e["contact_type"], e["identity"], e["kind"], e["inbound"], e["reply"], e["words"], e["sent_at"], e["mail_message_id"], e["thread_id"], e["why"]))
        if args.activate:
            cur.execute("update relay_voice set active = false where owner_id = %s and active", (owner_id,))
            cur.execute("update relay_voice set active = true where id = %s", (voice_id,))
    print(json.dumps({"voice_id": voice_id, "version": version, "situations": len(cards), "examples": len(bank), "active": bool(args.activate)}))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("command", choices=["extract", "tag", "synthesize", "eval", "eval-predraft", "eval-options", "publish", "render"])
    parser.add_argument("--owner", default="alex@rebattery.io")
    parser.add_argument("--dsn", default=DEFAULT_DSN)
    parser.add_argument("--work", type=Path)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--batch", type=int, default=30, help="emails per tagging call")
    parser.add_argument("--max-batches", type=int, default=0, help="tag at most N batches this run (0: all)")
    parser.add_argument("--n", type=int, default=30, help="held-out replies to evaluate")
    parser.add_argument("--chases", type=int, default=10, help="eval-predraft: recent chases to replay")
    parser.add_argument("--url", default="http://127.0.0.1:3100", help="eval-predraft: the CRM web app to replay through")
    parser.add_argument("--activate", action="store_true", help="publish: make this version the one Relay uses")
    parser.add_argument("--baseline", choices=["active", "none"], default="active", help="eval: compare with the voice in use, or with no voice")
    parser.add_argument("--render-to", type=Path, default=VOICE_FILE, help="render: the file every other drafter reads")
    args = parser.parse_args(argv)
    {"extract": extract, "tag": tag, "synthesize": synthesize, "eval": eval_, "eval-predraft": eval_predraft, "eval-options": eval_options, "publish": publish, "render": render}[args.command](args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
