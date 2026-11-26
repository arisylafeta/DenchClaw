"""Relay people: one person behind several email addresses.

Relay keys emails by address, so a person writing from two addresses looked like two people with two contradicting
replies (Chris wrote from threadofariadne.dev1@, eco.mobility.dev.1@ and chrismoenvegas@). This module links addresses
into one person when the evidence says so, and keeps the evidence:

  stated     their own email says another address is them ("on behalf of the same individual seller ... at x@y",
             "my other email"): the paragraph naming the address carries an identity phrase.
  alex       Alex said Yes to a suggestion.

Signatures are not proof (in a cleaned email a quoted colleague's signature can sit near the top), so the same signed name
and phone number, or an address named without an identity phrase, only make a suggestion for Alex, never a link.
Shared inboxes (info@, sales@ ...) and our own addresses are never linked. A pair Alex said No to is never linked again.
The scan runs link_people() each time; relay_person_address holds the links, relay_person_suggestion the open questions
(migration 137). Nothing here sends, labels or touches the CRM's own people.
"""
from __future__ import annotations

import re
import uuid
from dataclasses import dataclass, field

EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
SHARED = re.compile(r"^(info|sales|support|supply|buy|office|admin|contact|hello|enquiries|inquiries|enquiry|team|noreply|no-reply|"
                    r"donotreply|accounts|accounting|orders|service|customerservice|mail|post|jobs|hr|marketing|news|newsletter)@", re.I)
OURS = re.compile(r"@(rebattery\.io|rebattery\.com)$", re.I)
# Their own words that another address is the same person. "previously discussed with X at y" alone is not enough.
SAME_PERSON = re.compile(
    r"\b(same (individual |private )?(seller|person|sender|owner|vendor|individual)|on behalf of the same|"
    r"my (other|personal|private|work|business|second|old|new) (e-?mail|address|account|inbox)|"
    r"(this is|it'?s) (also )?me\b|also me\b|writing (to you )?from (my|another|a different) (e-?mail|address|account)|"
    r"not a (second|different|separate) (seller|person|sender))", re.I)
NAMED = re.compile(r"\b(previously discussed with|on behalf of|coordinat\w+ with|following up for|same (inventory|lot|batteries|modules))\b", re.I)
PHONE = re.compile(r"(?:\+|00)?\d[\d\s().-]{7,}\d")
NAME = re.compile(r"\b([A-Z][a-z]+(?:[-'][A-Z]?[a-z]+)?)\s+([A-Z][a-z]+(?:[-'][A-Z]?[a-z]+)?)\b")
NOT_NAMES = {"best", "kind", "regards", "thanks", "thank", "many", "dear", "hello", "with", "from", "sent", "the", "battery", "tesla",
             "energy", "solutions", "limited", "group", "company", "sales", "manager", "director", "united", "kingdom", "states",
             "road", "street", "house", "unit", "park", "phone", "mobile", "email", "website", "eco", "mobility"}


def clean(address: str | None) -> str:
    return (address or "").strip().lower().strip("<>.,;:()[]")


def linkable(address: str) -> bool:
    """A person's own address: not a shared inbox, not ours."""
    return bool(address) and "@" in address and not SHARED.match(address) and not OURS.search(address)


QUOTED = re.compile(r"(?m)^(On .{5,240}wrote:|-{3,} ?Original Message ?-{3,}|_{10,}|From: .{3,200}$|Le .{5,200}a écrit|Am .{5,200}schrieb|>)")


OWN_LINES = 30


def own_words(text: str) -> str:
    """Their own email, without the quoted thread under it: another person's signature or words never count as theirs.
    Cut at a quote marker, and in any case at the top 30 lines: people reply on top, and some mail clients drop the
    markers of the thread they quote."""
    m = QUOTED.search(text or "")
    top = (text or "")[: m.start()] if m else (text or "")
    kept, n = [], 0
    for line in top.splitlines():
        n += bool(line.strip())
        if n > OWN_LINES:
            break
        kept.append(line)
    return "\n".join(kept)


def paragraphs(text: str) -> list[str]:
    return [p for p in re.split(r"\n\s*\n", text or "") if p.strip()]


def signature(text: str) -> str:
    """The end of their own words, where names and phone numbers sit: the last 12 non-empty lines."""
    lines = [l.strip() for l in (text or "").splitlines() if l.strip()]
    return "\n".join(lines[-12:])


def phones(text: str) -> set[str]:
    """Phone numbers as their last 9 digits, so '+1 (850) 280-0998' and '850 280 0998' agree."""
    out = set()
    for m in PHONE.finditer(text or ""):
        digits = re.sub(r"\D", "", m.group(0))
        if 9 <= len(digits) <= 15:
            out.add(digits[-9:])
    return out


SIGN_LINE = re.compile(r"^([A-Z][a-z]+(?:[-'][A-Z]?[a-z]+)?)\s+([A-Z][a-z]+(?:[-'][A-Z]?[a-z]+)?)\s*(?:\(.*\)|[|,].*)?$")
GREETING = re.compile(r"^(hi|hello|hey|dear|good (morning|afternoon|evening)|thanks|thank you|best|kind|many)\b", re.I)


def names(text: str) -> set[str]:
    """Full names (first and last) signed on a line of their own, as a sign-off does, lower case. Greetings and place
    or company words never count."""
    out = set()
    for line in (text or "").splitlines():
        line = line.strip()
        if GREETING.match(line):
            continue
        m = SIGN_LINE.match(line)
        if not m:
            continue
        first, last = m.group(1).lower(), m.group(2).lower()
        if first in NOT_NAMES or last in NOT_NAMES:
            continue
        out.add(f"{first} {last}")
    return out


def signer(text: str) -> tuple[str | None, set[str]]:
    """Who signed their own reply: the first full name on a line of its own (a quoted signature further down is someone
    else's), and the phone numbers in the few lines under it."""
    lines = [l.strip() for l in (text or "").splitlines()]
    for i, line in enumerate(lines):
        found = names(line)
        if found:
            return sorted(found)[0], phones("\n".join(lines[i:i + 8]))
    return None, set()


PERSONAL = {"gmail.com", "googlemail.com", "hotmail.com", "hotmail.co.uk", "outlook.com", "live.com", "live.co.uk", "yahoo.com",
            "yahoo.co.uk", "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com", "gmx.de", "gmx.net", "web.de", "mail.com"}


def personal(address: str) -> bool:
    return address.split("@")[-1] in PERSONAL


def name_in(address: str, name: str) -> bool:
    """Part of the name is in the address ("chris" in chrismoenvegas@): a name alone is common, this ties it to them."""
    local = address.split("@")[0]
    return any(len(part) >= 3 and part in local for part in name.split())


@dataclass
class Edge:
    a: str
    b: str
    how: str          # stated | signature | (suggestion) name | named
    evidence: str     # the words it rests on
    message_id: str


@dataclass
class Found:
    links: list[Edge] = field(default_factory=list)
    suggestions: list[Edge] = field(default_factory=list)


def evidence(messages: list[dict]) -> Found:
    """Links and suggestions from inbound messages ({id, from_email, text}). Pure: no database."""
    found = Found()
    sig_names: dict[str, set[str]] = {}
    sig_phones: dict[str, set[str]] = {}
    first_id: dict[str, str] = {}
    for m in messages:
        sender = clean(m.get("from_email"))
        if not linkable(sender):
            continue
        text = own_words(m.get("text") or "")
        first_id.setdefault(sender, m.get("id") or "")
        for para in paragraphs(text):
            for other in {clean(x) for x in EMAIL.findall(para)}:
                if other == sender or not linkable(other):
                    continue
                quote = " ".join(para.split())[:400]
                if SAME_PERSON.search(para):
                    found.links.append(Edge(sender, other, "stated", quote, m.get("id") or ""))
                elif NAMED.search(para):
                    found.suggestions.append(Edge(sender, other, "named", quote, m.get("id") or ""))
        name, numbers = signer(text)
        if name:
            sig_names.setdefault(sender, set()).add(name)
            sig_phones.setdefault(sender, set()).update(numbers)
    senders = sorted(sig_names)
    for i, a in enumerate(senders):
        for b in senders[i + 1:]:
            shared_names = sig_names[a] & sig_names[b]
            if not shared_names:
                continue
            # A work address carries its owner's name; only a personal one (Gmail and the like) may not.
            tied = sorted(n for n in shared_names if (name_in(a, n) or name_in(b, n))
                          and all(name_in(x, n) or personal(x) for x in (a, b)))
            name = (tied or sorted(shared_names))[0]
            if tied and sig_phones.get(a, set()) & sig_phones.get(b, set()):
                found.suggestions.append(Edge(a, b, "signature", f"Both sign as {name.title()} with the same phone number", first_id.get(b, "")))
    return found


def groups(links: list[Edge], refused: set[frozenset]) -> list[set[str]]:
    """Addresses joined by links (a refused pair never joins), as groups of two or more."""
    parent: dict[str, str] = {}

    def root(x: str) -> str:
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for e in links:
        if frozenset((e.a, e.b)) in refused:
            continue
        parent[root(e.a)] = root(e.b)
    out: dict[str, set[str]] = {}
    for x in list(parent):
        out.setdefault(root(x), set()).add(x)
    return [g for g in out.values() if len(g) > 1]


# ---------- database (migration 137) ----------

def load(cur, owner_id: str) -> tuple[dict[str, str], set[frozenset]]:
    """address -> person key, and the pairs Alex said are not one person."""
    cur.execute("select to_regclass('relay_person_address') is not null as ok")
    if not cur.fetchone()["ok"]:
        return {}, set()
    cur.execute("select address, person_key from relay_person_address where owner_id = %s", (owner_id,))
    keys = {r["address"]: r["person_key"] for r in cur.fetchall()}
    cur.execute("select address, other_address from relay_person_suggestion where owner_id = %s and status = 'no'", (owner_id,))
    refused = {frozenset((r["address"], r["other_address"])) for r in cur.fetchall()}
    return keys, refused


def person_of(keys: dict[str, str]) -> dict[str, set[str]]:
    """address -> every address of the same person (itself included)."""
    by_key: dict[str, set[str]] = {}
    for address, key in keys.items():
        by_key.setdefault(key, set()).add(address)
    return {address: by_key[key] for address, key in keys.items()}


def link_people(cur, owner_id: str, messages: list[dict], apply: bool) -> dict:
    """Finds and saves links and suggestions from these inbound messages. Returns counts and the address -> person map."""
    keys, refused = load(cur, owner_id)
    found = evidence(messages)
    stored_links = [Edge(a, b, "stored", "", "") for a in keys for b in keys if a < b and keys[a] == keys[b]]
    new_links = 0
    by_edge = {frozenset((e.a, e.b)): e for e in found.links}
    for group in groups(found.links + stored_links, refused):
        existing = sorted({keys[a] for a in group if a in keys})
        key = existing[0] if existing else str(uuid.uuid4())
        for address in sorted(group):
            if keys.get(address) == key:
                continue
            edge = next((e for p, e in by_edge.items() if address in p and p & (group - {address})), None)
            new_links += 1
            if apply:
                cur.execute(
                    """insert into relay_person_address (owner_id, address, person_key, how, evidence, message_id)
                       values (%s, %s, %s, %s, %s, %s)
                       on conflict (owner_id, address) do update set person_key = excluded.person_key""",
                    (owner_id, address, key, edge.how if edge else "stated", edge.evidence if edge else "", edge.message_id if edge else None))
                # A group that joined two people takes one key.
                if address in keys and keys[address] != key:
                    cur.execute("update relay_person_address set person_key = %s where owner_id = %s and person_key = %s", (key, owner_id, keys[address]))
            keys[address] = key
    new_suggestions = 0
    for e in found.suggestions:
        pair = frozenset((e.a, e.b))
        if pair in refused or (keys.get(e.a) and keys.get(e.a) == keys.get(e.b)):
            continue
        new_suggestions += 1
        if apply:
            a, b = sorted(pair)
            cur.execute(
                """insert into relay_person_suggestion (owner_id, address, other_address, why, evidence, message_id)
                   values (%s, %s, %s, %s, %s, %s) on conflict (owner_id, address, other_address) do nothing""",
                (owner_id, a, b, e.how, e.evidence, e.message_id or None))
    return {"links": new_links, "suggestions": new_suggestions, "people": person_of(keys)}


def fold(latest: dict[str, object], people: dict[str, set[str]]) -> dict[str, object]:
    """A per-address 'when' map (last wrote to, last wrote in) made per person: each address gets the latest of its person's."""
    out = dict(latest)
    for address, everyone in people.items():
        times = [latest[a] for a in everyone if a in latest]
        if times:
            out[address] = max(times)
    return out
