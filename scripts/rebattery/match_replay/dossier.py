"""Read a buyer dossier and build an as-of view for the Matches replay.

The as-of view keeps only frontmatter products and price entries whose `seen`
date is strictly before the listing's offer date, and removes dated body lines
on or after that date. It also drops the "Open threads and promises" and
"Sources" sections, and whole "Bought from us" items dated on or after the
offer date.

This is a leakage control, not a general dossier reader. It is deliberately
conservative: undated prose can still describe later events, which the report
records as a caveat.
"""

from __future__ import annotations

import datetime as dt
import re
from pathlib import Path
from typing import Any

import yaml

MONTHS = {
    "jan": 1, "january": 1, "feb": 2, "february": 2, "mar": 3, "march": 3,
    "apr": 4, "april": 4, "may": 5, "jun": 6, "june": 6, "jul": 7, "july": 7,
    "aug": 8, "august": 8, "sep": 9, "sept": 9, "september": 9, "oct": 10,
    "october": 10, "nov": 11, "november": 11, "dec": 12, "december": 12,
}

DATE_PATTERNS = [
    re.compile(r"\b(\d{4})-(\d{2})-(\d{2})\b"),
    re.compile(r"\b(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})\b"),
    re.compile(r"\b([A-Za-z]{3,9})\s+(\d{4})\b"),
]


def parse_date(value: Any) -> dt.date | None:
    if value is None:
        return None
    if isinstance(value, dt.datetime):
        return value.date()
    if isinstance(value, dt.date):
        return value
    text = str(value).strip()
    if not text:
        return None
    m = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})", text)
    if m:
        try:
            return dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            return None
    m = re.fullmatch(r"(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})", text)
    if m and m.group(2).lower() in MONTHS:
        return dt.date(int(m.group(3)), MONTHS[m.group(2).lower()], int(m.group(1)))
    m = re.fullmatch(r"([A-Za-z]{3,9})\s+(\d{4})", text)
    if m and m.group(1).lower() in MONTHS:
        return dt.date(int(m.group(2)), MONTHS[m.group(1).lower()], 1)
    return None


def latest_date_in_text(text: str) -> dt.date | None:
    best: dt.date | None = None
    for pattern in DATE_PATTERNS:
        for m in pattern.finditer(text):
            parsed = parse_date(m.group(0))
            if parsed and (best is None or parsed > best):
                best = parsed
    return best


def split_frontmatter(text: str) -> tuple[dict[str, Any], str]:
    if not text.startswith("---"):
        raise ValueError("dossier has no YAML frontmatter")
    parts = text.split("---", 2)
    if len(parts) < 3:
        raise ValueError("unterminated YAML frontmatter")
    front = yaml.safe_load(parts[1]) or {}
    if not isinstance(front, dict):
        raise ValueError("frontmatter is not a mapping")
    return front, parts[2].lstrip("\n")


def _split_sections(body: str) -> list[tuple[str, list[str]]]:
    sections: list[tuple[str, list[str]]] = []
    title = ""
    lines: list[str] = []
    for line in body.splitlines():
        if line.startswith("## "):
            if title or lines:
                sections.append((title, lines))
            title = line[3:].strip()
            lines = []
        else:
            lines.append(line)
    if title or lines:
        sections.append((title, lines))
    return sections


def _drop_section(title: str) -> bool:
    lowered = title.strip().lower()
    return lowered.startswith("open threads") or lowered.startswith("sources")


def _filter_bought_items(lines: list[str], as_of: dt.date) -> list[str]:
    kept: list[str] = []
    block: list[str] = []

    def flush() -> None:
        if not block:
            return
        first = block[0]
        dated = latest_date_in_text(first)
        if dated is None or dated < as_of:
            kept.extend(block)
        block.clear()

    for line in lines:
        if line.startswith("- "):
            flush()
            block.append(line)
        elif block and (line.startswith("  ") or line.startswith("\t")):
            block.append(line)
        else:
            flush()
            kept.append(line)
    flush()
    return kept


def filter_body(body: str, as_of: dt.date) -> str:
    out: list[str] = []
    for title, lines in _split_sections(body):
        if _drop_section(title):
            continue
        if title.strip().lower() == "bought from us":
            lines = _filter_bought_items(lines, as_of)
        # Drop any remaining single dated line dated on or after the offer.
        kept: list[str] = []
        for line in lines:
            dated = latest_date_in_text(line)
            if dated is not None and dated >= as_of:
                continue
            kept.append(line)
        if title:
            out.append(f"## {title}")
        out.extend(kept)
    return "\n".join(out).strip() + "\n"


def filter_frontmatter(front: dict[str, Any], as_of: dt.date) -> dict[str, Any]:
    front = dict(front)
    for key in ("products", "price"):
        rows = front.get(key)
        if not isinstance(rows, list):
            continue
        kept = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            seen = parse_date(row.get("seen"))
            if seen is None or seen < as_of:
                kept.append(row)
        front[key] = kept
    # These fields routinely restate later evidence. Drop them from the
    # as-of view rather than risk quoting a post-dated fact to the caseworker.
    front.pop("conflicts", None)
    seen_dates = [
        parse_date(row.get("seen"))
        for key in ("products", "price")
        for row in (front.get(key) or [])
        if isinstance(row, dict)
    ]
    seen_dates = [d for d in seen_dates if d]
    if seen_dates:
        front["last_verified"] = max(seen_dates).isoformat()
    else:
        front.pop("last_verified", None)
    return front


def load_dossier(path: str | Path, as_of: str | dt.date) -> dict[str, Any]:
    as_of_date = parse_date(as_of)
    if as_of_date is None:
        raise ValueError(f"bad as_of date: {as_of!r}")
    text = Path(path).read_text(encoding="utf-8")
    front, body = split_frontmatter(text)
    return {
        "path": str(path),
        "company_id": front.get("company_id"),
        "company": front.get("company"),
        "frontmatter": filter_frontmatter(front, as_of_date),
        "body": filter_body(body, as_of_date),
        "as_of": as_of_date.isoformat(),
    }
