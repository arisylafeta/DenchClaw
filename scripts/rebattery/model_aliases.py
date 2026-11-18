#!/usr/bin/env python3
"""Canonical model slugs and free-text model/make/cell-format readers for the Wants conformance checker.

The alias list is model_aliases.json next to this file. Read-only helpers, no database.
"""
import json
import re
import unicodedata
from pathlib import Path

ALIASES_PATH = Path(__file__).resolve().parent / "model_aliases.json"
_DATA = json.loads(ALIASES_PATH.read_text(encoding="utf-8"))
MAKE_ALIASES = _DATA["makeAliases"]
VARIANT_WORDS = ("long", "range", "standard", "awd", "rwd", "fwd", "4wd", "2wd", "lr", "sr", "dual", "motor",
                 "performance", "premium", "se")
BRAND_WORDS = ("volkswagen", "vw", "audi", "mini", "skoda", "cupra", "porsche", "bmw", "mercedes-benz", "mercedes", "tesla",
               "stellantis", "nissan", "renault", "dacia", "peugeot", "citroen", "opel", "vauxhall", "fiat", "jeep", "ford",
               "hyundai", "kia", "genesis", "toyota", "lexus", "honda", "mazda", "mitsubishi", "suzuki", "subaru", "volvo",
               "polestar", "jaguar", "land rover", "mg", "byd", "lotus", "lucid", "rivian", "nio", "xpeng", "zeekr",
               "leapmotor", "maxus", "smart", "seat")
_FROM = "àáâãäåāăąçćčďèéêëēėęěìíîïīįñńňòóôõöøōőťùúûüūůűýÿžźżšśł"
_TO = "aaaaaaaaacccdeeeeeeeeiiiiiinnnooooooootuuuuuuuyyzzzssl"
_TABLE = str.maketrans(_FROM, _TO)


def unaccent(value):
    return (value or "").lower().translate(_TABLE)


def fold(value):
    return re.sub(r"[^a-z0-9]+", "", unaccent(value))


def make_fold(make):
    folded = fold(make)
    return MAKE_ALIASES.get(folded, folded)


def _alias_rows():
    """(own make, alias, slug, global) for every alias; global = may match a line that states no make."""
    owners = {}
    for model in _DATA["models"]:
        for alias in model["aliases"]:
            owners.setdefault(alias, set()).add(model["slug"])
    rows = []
    for model in _DATA["models"]:
        for alias in model["aliases"]:
            is_global = len(owners[alias]) == 1 and len(alias.replace(" ", "")) > 2 and not alias.replace(" ", "").isdigit()
            rows.append((make_fold(model["make"]), alias, model["slug"], is_global))
    return rows


ALIAS_ROWS = _alias_rows()


def lists_models(raw):
    """A model text that lists vehicles (comma, semicolon, colon) names no single model."""
    return bool(re.search(r"[,;:]", raw or ""))


def normal_tokens(raw, make=None):
    # Years are dropped unless the model is itself year-like (Peugeot 2008): then nothing else would be left.
    return _normal_pass(raw, make, True) or _normal_pass(raw, make, False)


def _normal_pass(raw, make, drop_years):
    text = unaccent(raw)
    text = re.sub(r"\b\d+(?:\.\d+)?\s*(?:kwh|kw|ps|hp|bhp|ah)\b", " ", text)
    text = re.sub(r"\([^)]*\)|\[[^\]]*\]", " ", text)
    if drop_years:
        text = re.sub(r"\b(?:19|20)\d{2}\b", " ", text)
    text = re.sub(r"\b(?:battery|batteries|packs?|modules?|hv|high voltage)\b", " ", text)
    text = " ".join(re.sub(r"[^a-z0-9]+", " ", text).split())
    tokens = text.split()
    own = " ".join(re.sub(r"[^a-z0-9]+", " ", unaccent(make)).split()) if make else ""
    brands = sorted({own, *BRAND_WORDS} - {""}, key=len, reverse=True)
    for brand in brands:
        spaced = " ".join(re.sub(r"[^a-z0-9]+", " ", brand).split())
        if text.startswith(spaced + " "):
            text = text[len(spaced) + 1:]
            break
    tokens = text.split()
    while len(tokens) > 1 and tokens[-1] in VARIANT_WORDS:
        tokens.pop()
    return " ".join(tokens)


def model_slug(make, raw):
    """The canonical slug for a model text under a make, or the folded normal text when no alias names it. None when
    the text names no single model."""
    if not (raw or "").strip() or lists_models(raw):
        return None
    norm = normal_tokens(raw, make)
    if not norm:
        return None
    mk = make_fold(make) if make else None
    exact_only = "/" in raw
    best = None
    for own, alias, slug, is_global in ALIAS_ROWS:
        if not (norm == alias or (not exact_only and norm.startswith(alias + " "))):
            continue
        if not (own == mk or is_global):
            continue
        rank = (own == mk, len(alias))
        if best is None or rank > best[0]:
            best = (rank, slug)
    if best:
        return best[1]
    if exact_only or len(norm.split()) >= 4:
        return None  # a slash list or a sentence, never a single unknown model
    return fold(norm) or None


def _spaced(value):
    return " ".join(re.sub(r"[^a-z0-9]+", " ", unaccent(value)).split())


def _text_rows():
    """(own make fold, display make, spaced alias, slug, display model name, names a model alone) for every alias."""
    owners = {}
    for model in _DATA["models"]:
        for alias in model["aliases"]:
            owners.setdefault(alias, set()).add(model["slug"])
    rows = []
    for model in _DATA["models"]:
        for alias in model["aliases"]:
            alone = len(owners[alias]) == 1 and len(alias.replace(" ", "")) > 2 and bool(re.search(r"\d", alias))
            rows.append((make_fold(model["make"]), model["make"], _spaced(alias), model["slug"], model["name"], alone))
    return rows


TEXT_ROWS = _text_rows()


def text_models(text, makes=()):
    """Models a free text names: [{make, model, slug}], longest alias first, one per model. An alias counts when its make is
    named (in `makes` or as a word of the text) or when it carries a digit and one model owns it (model 3, ev6). A bare word
    (leaf, bolt, volt) needs its make named. Mirrors buyer_interest_text_models() in SQL and wants_conformance._model_hits."""
    words = " " + _spaced(text) + " "
    hints = {make_fold(w) for w in words.split()}
    for value in makes or ():
        hints |= {make_fold(piece) for piece in re.split(r"\s*(?:,|/|&|\band\b)\s*", str(value)) if piece.strip()}
    found, seen = [], set()
    for own, display, alias, slug, name, alone in sorted(TEXT_ROWS, key=lambda row: -len(row[2])):
        if (own in hints or alone) and f" {alias} " in words and (own, slug) not in seen:
            seen.add((own, slug))
            found.append({"make": display, "model": name, "slug": slug})
    return found


# Words a buyer text uses for what it does not want or sells; a make or model after one of them in the same clause is not asked for.
_REFUSAL = re.compile(r"\b(?:no|not|never|dont|don t|doesn t|avoid|except|excluding|without|sell|sells|selling|offer|offers|supply|supplies|supplier)\b")
_AMBIGUOUS_MAKES = {"smart", "mini", "seat", "lucid", "genesis"}  # common words: a make only when a model says so
# Model names so particular to one battery source that a text naming them alone asks for them (the SQL list needs a digit or a make).
BARE_MODELS = ("leaf", "volt")
_MAKE_DISPLAY = {}
for _m in _DATA["models"]:
    _MAKE_DISPLAY.setdefault(make_fold(_m["make"]), _m["make"])
CELL_FORMATS = ("18650", "21700")


def _clause_before(text, alias):
    """The words before each mention of `alias` in its own clause (a mention per item); [] when the text has none."""
    pattern = r"(?<![a-z0-9])" + r"[^a-z0-9]+".join(re.escape(w) for w in alias.split()) + r"(?![a-z0-9])"
    low = unaccent(text)
    out = []
    for hit in re.finditer(pattern, low):
        start = max(low.rfind(c, 0, hit.start()) for c in ".;!?\n")
        out.append(_spaced(low[start + 1:hit.start()]))
    return out


def _asked(text, alias):
    """True when some mention of the alias is not behind a refusal word of its own clause."""
    return any(not _REFUSAL.search(before) for before in _clause_before(text, alias))


def text_makes(text):
    """Vehicle makes a text names (display names), unless every mention sits behind a refusal word."""
    words = " " + _spaced(text) + " "
    found = []
    for fold_name, display in _MAKE_DISPLAY.items():
        if fold_name in _AMBIGUOUS_MAKES:
            continue
        aliases = {_spaced(display), fold_name} | {k for k, v in MAKE_ALIASES.items() if v == fold_name}
        for alias in aliases:
            if f" {alias} " in words and _asked(text, alias):
                found.append(display)
                break
    return found


def text_stated_models(text, makes=()):
    """text_models plus the bare model names a battery text asks for on their own (Leaf, Volt), refusals left out."""
    hits = {row["slug"]: row for row in text_models(text, makes)}
    words = " " + _spaced(text) + " "
    for own, display, alias, slug, name, _alone in TEXT_ROWS:
        if slug in BARE_MODELS and alias in BARE_MODELS and slug not in hits and f" {alias} " in words:
            hits[slug] = {"make": display, "model": name, "slug": slug}
    return [row for row in hits.values()
            if any(_asked(text, alias) for _o, _d, alias, slug, _n, _a in TEXT_ROWS if slug == row["slug"]
                   and f" {alias} " in " " + _spaced(text) + " ")]


def text_cell_formats(text):
    """Cell formats (18650, 21700) a text names, in the order it names them."""
    return list(dict.fromkeys(re.findall(r"(?<![0-9])(18650|21700)(?![0-9])", str(text or ""))))


def text_min_ah(text):
    """The Ah minimum a text states (\"at least 200ah\", \"min 100 Ah\", \"200Ah+\"), or None."""
    number = r"(\d+(?:[.,]\d+)?)\s*-?\s*ah\b"
    for pattern in (rf"(?:at least|minimum(?: of)?|min\.?|no less than|not less than|from|over|above|>=|≥)\s*{number}",
                    rf"{number}\s*(?:\+|or more|or above|or higher|minimum|min\b|and (?:up|above|over))"):
        match = re.search(pattern, str(text or ""), re.I)
        if match:
            return float(match.group(1).replace(",", "."))
    return None


_QTY_UNITS = r"(units?|pcs|pieces?|packs?|modules?|cells?|batteries|systems?|vehicles?|containers?)"


def text_quantity(text):
    """(quantity, unit) a text states after a start-from word (\"start from 8,000 units\"), or None. A bare number
    next to a noun (Model 3 packs) is not a quantity, and a cell format code is never one."""
    match = re.search(r"(?:start(?:ing)?\s+from|starting\s+at|at least|minimum(?: of)?|min\.?|around|about|approx\.?|up to|need|needs)\s+"
                      rf"(\d{{1,3}}(?:[.,]\d{{3}})+|\d+)\s*(?:x\s*)?{_QTY_UNITS}\b", str(text or ""), re.I)
    if not match:
        return None
    digits = match.group(1)
    value = float(re.sub(r"[.,](?=\d{3}\b)", "", digits).replace(",", "."))
    if str(int(value)) in CELL_FORMATS or value <= 0:
        return None
    unit = match.group(2).lower()
    unit = {"pcs": "units", "piece": "units", "pieces": "units", "unit": "units"}.get(unit, unit if unit.endswith("s") else unit + "s")
    return value, unit
