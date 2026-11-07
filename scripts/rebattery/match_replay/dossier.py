"""Read a buyer dossier and build a strict as-of view for the Matches replay.

The as-of view is deliberately literal:

- a frontmatter ``products`` or ``price`` row survives only when it carries a
  parseable ``seen`` date strictly before the listing's offer date;
- a body line survives only when it starts with an ISO date strictly before
  that date (an optional leading ``- `` bullet is allowed); undated lines are
  dropped, section headings are the only exception;
- the "Open threads and promises" and "Sources" sections are dropped wholesale.

Undated evidence is not shown to any arm. This is the leakage control the v1
report asked for, and it is stricter than a best-effort date parse.
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

# A body fact line must open with an ISO date, optionally after a bullet.
ISO_LINE = re.compile(r"^\s*(?:[-*]\s*)?(\d{4})-(\d{2})-(\d{2})\b")


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


def line_date(line: str) -> dt.date | None:
    """Date a body line only when it opens with an ISO date."""
    m = ISO_LINE.match(line)
    if not m:
        return None
    try:
        return dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    except ValueError:
        return None


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


def filter_body(body: str, as_of: dt.date) -> str:
    """Keep only dated, strictly-earlier fact lines; keep section headings."""
    out: list[str] = []
    for title, lines in _split_sections(body):
        if _drop_section(title):
            continue
        kept: list[str] = []
        for line in lines:
            dated = line_date(line)
            if dated is not None and dated < as_of:
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
            if seen is not None and seen < as_of:
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
