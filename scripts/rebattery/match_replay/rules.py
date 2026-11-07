"""Match rules for the Phase 1 replay.

A0 is a faithful Python port of apps/web/lib/buyer-suggestions.ts, used for the
"current logic" arm. `a0_parity.ts` runs the real TypeScript and the runner
compares the two on every case and buyer.

A1 is the new rules layer described in BUILD-PLAN.md: rule out only on a
conflict both sides state, then order by fixed keys. Missing facts never rule
anyone out.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Any

STAGE_RANK = {
    "Customer": 6,
    "Bidding": 5,
    "Qualified": 4,
    "In conversation": 3,
    "Responded": 2,
    "Contacted": 1,
    "Identified": 0,
}
TIER_RANK = {"A": 2, "B": 1, "C": 0}
PRICE_BASIS_RANK = {"paid": 3, "quoted_by_buyer": 2, "stated_target": 1}

GENERIC = {
    "battery", "batteries", "pack", "packs", "module", "modules", "cell", "cells",
    "kwh", "kw", "ev", "evs", "hv", "used", "new", "second", "life", "tested",
    "untested", "complete", "for", "and", "or", "the", "a", "an", "of", "with",
    "from", "to", "van", "vans", "car", "cars", "traction", "bess", "container",
    "pilot", "storage", "stationary", "units", "unit", "approx", "approximately",
    "mixed", "etc", "lithium", "li", "ion", "lfp", "nmc", "nca", "lmo", "lto",
}


def _list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(x).strip() for x in value if isinstance(x, (str, int, float)) and str(x).strip()]
    if isinstance(value, str) and value.strip():
        return [value.strip()]
    return []


def _rule_entry_value(item: Any) -> str | None:
    """One rules_out or evidence_required entry: a plain value, or a {value, seen, src} mapping."""
    if isinstance(item, dict):
        value = item.get("value")
        return value.strip() if isinstance(value, str) and value.strip() else None
    if isinstance(item, (str, int, float)) and str(item).strip():
        return str(item).strip()
    return None


def _rule_values(value: Any) -> list[str]:
    """rules_out and evidence_required lists, with dated entries unwrapped to their value."""
    if isinstance(value, list):
        return [v for v in (_rule_entry_value(x) for x in value) if v]
    single = _rule_entry_value(value)
    return [single] if single else []


def norm(text: Any) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(text or "").lower()).strip()


def norm_loose(text: Any) -> str:
    """Accent-insensitive normalisation, used only for body-keyword matching."""
    folded = unicodedata.normalize("NFKD", str(text or "")).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", " ", folded.lower()).strip()


def tokens(text: Any) -> list[str]:
    return [t for t in norm(text).split() if len(t) > 1 and t not in GENERIC]


# --- A0: port of apps/web/lib/buyer-suggestions.ts -------------------------

def a0_supply_profile(listing: dict[str, Any]) -> dict[str, Any]:
    fmt = (listing.get("format") or "").capitalize() or None
    return {
        "chemistry": (listing.get("chemistry") or None),
        "format": fmt,
        "text": f"{listing.get('model') or ''} {listing.get('title') or ''}".lower(),
        "country": listing.get("country") or None,
    }


def a0_score_buyer(supply: dict[str, Any], raw: dict[str, Any]) -> dict[str, Any] | None:
    matched: list[str] = []
    gaps: list[str] = []
    chems = [c.upper() for c in _list(raw.get("chemistries"))]
    formats = _list(raw.get("formats"))
    if chems:
        if not supply["chemistry"]:
            gaps.append(f"Supply chemistry not stated (buyer wants {'/'.join(chems)})")
        elif supply["chemistry"].upper() in chems:
            matched.append(f"Chemistry {supply['chemistry'].upper()}")
        else:
            return None
    if formats:
        if not supply["format"]:
            gaps.append(f"Supply format not stated (buyer wants {'/'.join(formats)})")
        elif any(f.lower() == supply["format"].lower() for f in formats):
            matched.append(f"Format {supply['format']}")
        else:
            return None
    hay = f" {norm(supply['text'])} "
    makes = _list(raw.get("makes")) + _list(raw.get("cell_makers"))
    if makes:
        hit = next((m for m in makes if len(norm(m)) > 1 and f" {norm(m)} " in hay), None)
        if hit:
            matched.append(f"Make {hit}")
        else:
            gaps.append(f"Buyer names makes ({', '.join(makes[:3])}); none is this supply")
    origins = _list(raw.get("origins"))
    if origins:
        if supply["country"] and any(o.lower() == supply["country"].lower() for o in origins):
            matched.append(f"Origin {supply['country']}")
        elif supply["country"]:
            gaps.append(f"Buyer sources from {', '.join(origins[:3])}; this is {supply['country']}")
    if not any(m.startswith("Chemistry") or m.startswith("Format") for m in matched):
        return None
    return {"matched": matched, "gaps": gaps, "score": len(matched) * 2 - len(gaps)}


def a0_rank(supply: dict[str, Any], buyers: list[dict[str, Any]]) -> list[dict[str, Any]]:
    scored = []
    for index, buyer in enumerate(buyers):
        fit = a0_score_buyer(supply, buyer.get("profile") or {})
        if fit is None:
            continue
        scored.append({
            "company_id": buyer["id"],
            "name": buyer["name"],
            "fit": fit,
            "basis": buyer.get("basis"),
            "stage": buyer.get("stage"),
            "tier": buyer.get("tier"),
            "is_lead": is_lead(buyer),
            "_index": index,
        })

    def key(row: dict[str, Any]) -> tuple:
        return (
            -(1 if row["basis"] == "stated" else 0),
            -STAGE_RANK.get(row["stage"] or "", 0),
            -TIER_RANK.get(row["tier"] or "", -1),
            -row["fit"]["score"],
            row["_index"],
        )

    scored.sort(key=key)
    for row in scored:
        row.pop("_index", None)
    return scored


def is_lead(buyer: dict[str, Any]) -> bool:
    return buyer.get("basis") != "stated" and (not buyer.get("stage") or buyer.get("stage") == "Identified")


# --- A1: rules layer -------------------------------------------------------

PLATFORM_GROUPS = [
    {"meb"},
    {"e cmp", "ecmp", "cmp", "smart car"},
    {"e k9", "ek9", "k9"},
    {"k0"},
    {"stla m"},
    {"stla"},
    {"egmp", "e gmp"},
    {"ze1"},
]


def _platform_key(value: Any) -> str | None:
    key = norm(value)
    if not key:
        return None
    for index, group in enumerate(PLATFORM_GROUPS):
        if key in group:
            return f"g{index}"
    return key


def platform_match(a: Any, b: Any) -> bool:
    ka, kb = _platform_key(a), _platform_key(b)
    return bool(ka and kb and ka == kb)


def _chem_match(listing: dict[str, Any], chemistries: list[str]) -> bool:
    chem = (listing.get("chemistry") or "").upper()
    return bool(chem and chem in [c.upper() for c in chemistries])


def _format_match(listing: dict[str, Any], formats: list[str]) -> bool:
    fmt = (listing.get("format") or "").lower()
    return bool(fmt and fmt in [f.lower() for f in formats])


def _dossier_products(buyer: dict[str, Any]) -> list[dict[str, Any]]:
    dossier = buyer.get("dossier") or {}
    front = dossier.get("frontmatter") or {}
    products = front.get("products") or []
    return [p for p in products if isinstance(p, dict)]


def _dossier_rules(buyer: dict[str, Any]) -> dict[str, Any]:
    dossier = buyer.get("dossier") or {}
    front = dossier.get("frontmatter") or {}
    rules = front.get("rules_out") or {}
    return rules if isinstance(rules, dict) else {}


def _dossier_price(buyer: dict[str, Any]) -> dict[str, Any] | None:
    dossier = buyer.get("dossier") or {}
    front = dossier.get("frontmatter") or {}
    rows = [r for r in (front.get("price") or []) if isinstance(r, dict)]
    if not rows:
        return None
    return max(
        rows,
        key=lambda r: (PRICE_BASIS_RANK.get(str(r.get("basis") or ""), 0), float(r.get("eur_per_kwh") or r.get("eur_per_unit") or 0)),
    )


def _buyer_chemistries(buyer: dict[str, Any]) -> list[str]:
    if buyer.get("dossier"):
        return [str(p.get("chemistry")) for p in _dossier_products(buyer) if p.get("chemistry")]
    return _list((buyer.get("profile") or {}).get("chemistries"))


def _buyer_formats(buyer: dict[str, Any]) -> list[str]:
    if buyer.get("dossier"):
        return [str(p.get("format")) for p in _dossier_products(buyer) if p.get("format")]
    return _list((buyer.get("profile") or {}).get("formats"))


def _buyer_part_numbers(buyer: dict[str, Any]) -> list[str]:
    if buyer.get("dossier"):
        return [str(p.get("part_number")) for p in _dossier_products(buyer) if p.get("part_number")]
    profile = buyer.get("profile") or {}
    return _list(profile.get("part_numbers"))


def _wants_text(buyer: dict[str, Any]) -> str:
    profile = buyer.get("profile") or {}
    return str(profile.get("wants") or "")


def _profile_models(buyer: dict[str, Any]) -> list[str]:
    profile = buyer.get("profile") or {}
    return _list(profile.get("models"))


def _product_platforms(buyer: dict[str, Any]) -> list[str]:
    return [str(p.get("platform")) for p in _dossier_products(buyer) if p.get("platform")]


def _filtered_past_asks(profile: dict[str, Any], as_of: str) -> list[str]:
    """Dated asks strictly before the offer; undated asks are dropped."""
    out = []
    for item in profile.get("past_asks") or []:
        if not isinstance(item, dict):
            continue
        date = str(item.get("date") or "")[:10]
        if not date or date >= as_of:
            continue
        if item.get("wants"):
            out.append(str(item["wants"]))
    return out


def _fallback_text(buyer: dict[str, Any], as_of: str) -> str:
    """Product words from the strict-dated dossier body and dated past asks.

    ``dossier.body`` has already been reduced to lines dated strictly before
    the offer, so this second look cannot read undated prose. A buyer with no
    dossier contributes nothing here; the profile checks above still apply.
    """
    parts: list[str] = []
    dossier = buyer.get("dossier") or {}
    if dossier.get("body"):
        parts.append(str(dossier["body"]))
    profile = buyer.get("profile") or {}
    parts.extend(_filtered_past_asks(profile, as_of))
    return f" {norm_loose(' '.join(parts))} "


def product_tier(listing: dict[str, Any], buyer: dict[str, Any], as_of: str, body_fallback: bool = True) -> int:
    """4 part number, 3 model/platform, 2 make, 1 chemistry+format, 0 none.

    ``body_fallback=False`` is the A1-strict arm: frontmatter and profile
    facts only, with no keyword read of the dossier body.
    """
    part = norm(listing.get("part_number"))
    if part:
        for candidate in _buyer_part_numbers(buyer):
            if norm(candidate) == part:
                return 4
        if f" {part} " in f" {norm(_wants_text(buyer))} ":
            return 4

    listing_models = tokens(listing.get("model"))
    listing_platform = listing.get("platform")
    for product in _dossier_products(buyer):
        if listing_platform and product.get("platform") and platform_match(listing_platform, product.get("platform")):
            return 3
        if listing_models and product.get("model"):
            product_norm = norm(product.get("model"))
            if any(f" {m} " in f" {product_norm} " for m in listing_models):
                return 3
    for model in _profile_models(buyer):
        if listing_models and any(f" {m} " in f" {norm(model)} " for m in listing_models):
            return 3
    wants_norm = norm(_wants_text(buyer))
    if listing_models and any(f" {m} " in f" {wants_norm} " for m in listing_models):
        return 3
    if listing_platform and f" {norm(listing_platform)} " in f" {wants_norm} ":
        return 3

    listing_makes = [t for t in tokens(listing.get("make")) if t not in {"group"}]
    if listing_makes:
        for product in _dossier_products(buyer):
            if product.get("make") and any(f" {m} " in f" {norm(product.get('make'))} " for m in listing_makes):
                return 2
        profile = buyer.get("profile") or {}
        for make in _list(profile.get("makes")) + _list(profile.get("cell_makers")):
            if any(f" {m} " in f" {norm(make)} " for m in listing_makes):
                return 2
        if any(f" {m} " in f" {wants_norm} " for m in listing_makes):
            return 2

    chem_ok = _chem_match(listing, _buyer_chemistries(buyer))
    fmt_ok = _format_match(listing, _buyer_formats(buyer))
    early_tier1 = bool(
        (chem_ok and fmt_ok)
        or (chem_ok and not listing.get("format"))
        or (fmt_ok and not listing.get("chemistry"))
        or (fmt_ok and not _buyer_chemistries(buyer))
    )
    if not body_fallback:
        return 1 if early_tier1 else 0

    # Last resort: product words in the strict-dated dossier body and asks.
    text = _fallback_text(buyer, as_of)
    if part and f" {part} " in text:
        return 4
    if listing_platform and f" {norm_loose(listing_platform)} " in text:
        return 3
    if listing_models and any(f" {m} " in text for m in listing_models):
        return 3
    if listing_makes and any(f" {m} " in text for m in listing_makes):
        return 2
    chem_word = norm_loose(listing.get("chemistry"))
    fmt_word = norm_loose(listing.get("format"))
    chem_hit = bool(chem_word and f" {chem_word} " in text)
    fmt_hit = bool(fmt_word and (f" {fmt_word} " in text or f" {fmt_word.rstrip('s')} " in text))
    if (chem_hit and fmt_hit) or (fmt_hit and not listing.get("chemistry")) or (chem_hit and not listing.get("format")) or (fmt_hit and not _buyer_chemistries(buyer)):
        return 1
    return 1 if early_tier1 else 0


def _body_kwh_bounds(body: str) -> tuple[float, float] | None:
    text = body or ""
    m = re.search(r"(\d+(?:\.\d+)?)\s*(?:-|to|–)\s*(\d+(?:\.\d+)?)\s*kwh", text, re.I)
    if m:
        lo, hi = float(m.group(1)), float(m.group(2))
        return (min(lo, hi), max(lo, hi))
    m = re.search(r"(\d+(?:\.\d+)?)\s*kwh\s*(?:minimum|min\b)", text, re.I)
    if m:
        return (float(m.group(1)), 10_000.0)
    m = re.search(r"(?:minimum|at least|min(?:imum)?)\s*(\d+(?:\.\d+)?)\s*kwh", text, re.I)
    if m:
        return (float(m.group(1)), 10_000.0)
    return None


def _kwh_values(product: dict[str, Any]) -> list[float]:
    values = product.get("kwh")
    if isinstance(values, list):
        return [float(v) for v in values if isinstance(v, (int, float))]
    if isinstance(values, (int, float)):
        return [float(values)]
    return []


def _relative_gap(value: float, target: float) -> float:
    return abs(value - target) / target if target else 1.0


def _within_profile_kwh(listing: dict[str, Any], buyer: dict[str, Any], tolerance: float) -> bool:
    profile = buyer.get("profile") or {}
    lo = profile.get("kwh_min")
    hi = profile.get("kwh_max")
    kwh = listing.get("kwh")
    if kwh is None or (lo is None and hi is None):
        return False
    kwh = float(kwh)
    if lo is not None and kwh < float(lo) * (1 - tolerance):
        return False
    if hi is not None and kwh > float(hi) * (1 + tolerance):
        return False
    return True


def rule_out(listing: dict[str, Any], buyer: dict[str, Any]) -> tuple[str, str] | None:
    """Return (code, detail) when an as-of dossier or stated buy box rules the lot out."""
    is_dossier = bool(buyer.get("dossier"))
    rules = _dossier_rules(buyer) if is_dossier else {}
    profile = buyer.get("profile") or {}
    chem = (listing.get("chemistry") or "").upper()
    fmt = (listing.get("format") or "").lower()

    if is_dossier:
        ruled = [str(c).upper() for c in _rule_values(rules.get("chemistries"))]
        if chem and chem in ruled:
            return ("chemistry", f"rules_out.chemistries includes {chem}")
        ruled_formats = [str(f).lower() for f in _rule_values(rules.get("formats"))]
        if fmt and fmt in ruled_formats:
            return ("format", f"rules_out.formats includes {fmt}")
    else:
        stated = [str(c).upper() for c in _list(profile.get("chemistries"))]
        if chem and stated and chem not in stated:
            return ("chemistry", f"buy profile chemistries are {'/'.join(stated)}")
        stated_formats = [str(f).lower() for f in _list(profile.get("formats"))]
        if fmt and stated_formats and fmt not in stated_formats:
            return ("format", f"buy profile formats are {'/'.join(stated_formats)}")

    # A platform is only a conflict when the buyer explicitly refuses it.
    if is_dossier and listing.get("platform"):
        for phrase in _rule_values(rules.get("other")):
            text = norm(phrase)
            if platform_match(listing.get("platform"), phrase) or f" {norm(listing.get('platform'))} " in f" {text} ":
                if any(word in text for word in ("will not accept", "not interchangeable", "not acceptable", "refuses")):
                    return ("platform", f"rules_out.other: {phrase}")

    # Capacity: only for packs/modules, and only when the buyer has a stated
    # capacity on the same format. A same-platform capacity difference is
    # treated as a substitution candidate, not a conflict.
    if listing.get("kwh") is not None and fmt in {"packs", "modules"}:
        if is_dossier:
            products = [p for p in _dossier_products(buyer) if str(p.get("format") or "").lower() == fmt and _kwh_values(p)]
            same_platform = any(
                listing.get("platform") and p.get("platform") and platform_match(listing.get("platform"), p.get("platform"))
                for p in _dossier_products(buyer)
            )
            if products and not same_platform:
                tolerance = 0.15
                substitution = (buyer.get("dossier") or {}).get("frontmatter", {}).get("substitution") or {}
                if isinstance(substitution, dict) and substitution.get("kwh_tolerance") is not None:
                    tolerance = float(substitution["kwh_tolerance"])
                best = min(_relative_gap(float(listing["kwh"]), v) for p in products for v in _kwh_values(p))
                body_bounds = _body_kwh_bounds(str((buyer.get("dossier") or {}).get("body") or ""))
                body_covers = bool(
                    body_bounds
                    and body_bounds[0] * (1 - tolerance) <= float(listing["kwh"]) <= body_bounds[1] * (1 + tolerance)
                )
                if best > tolerance and not body_covers and not _within_profile_kwh(listing, buyer, tolerance):
                    return ("kwh", f"stated {fmt} capacity is {best:.0%} away from {listing['kwh']} kWh")
        else:
            if not _within_profile_kwh(listing, buyer, 0.15) and (profile.get("kwh_min") is not None or profile.get("kwh_max") is not None):
                return ("kwh", f"buy profile kWh bounds exclude {listing['kwh']} kWh")

    if is_dossier and listing.get("damaged_mixed") and rules.get("damaged") is True:
        return ("damaged", "buyer will not take damaged stock")
    if fmt == "systems":
        if is_dossier and rules.get("bess_systems") is True:
            return ("bess", "buyer will not take containerised/stationary systems")
        stated_formats = [f.lower() for f in _list(profile.get("formats"))]
        if stated_formats == ["packs"]:
            return ("bess", "packs-only buyer")
    if listing.get("whole_batch"):
        quantity = ((buyer.get("dossier") or {}).get("frontmatter", {}).get("quantity") or {}) if is_dossier else {}
        if isinstance(quantity, dict) and quantity.get("whole_batch_ok") is False:
            return ("whole_batch", "buyer will not take an indivisible batch")

    seller = norm(listing.get("seller"))
    if seller and norm(buyer.get("name")) == seller:
        return ("seller", "seller's own company")
    return None


def _price_key(listing: dict[str, Any], buyer: dict[str, Any]) -> tuple[int, int, float]:
    row = _dossier_price(buyer)
    buyer_kwh = None
    buyer_unit = None
    basis_rank = 0
    if row:
        buyer_kwh = row.get("eur_per_kwh")
        buyer_unit = row.get("eur_per_unit")
        basis_rank = PRICE_BASIS_RANK.get(str(row.get("basis") or ""), 0)
    seller_kwh = listing.get("seller_price_eur_per_kwh")
    seller_unit = listing.get("seller_price_eur_per_unit")
    if buyer_kwh is not None and seller_kwh is not None:
        spread = float(buyer_kwh) - float(seller_kwh)
        return (3 if spread >= 0 else 1, basis_rank, spread / float(seller_kwh) if seller_kwh else 0.0)
    if buyer_unit is not None and seller_unit is not None:
        spread = float(buyer_unit) - float(seller_unit)
        return (3 if spread >= 0 else 1, basis_rank, spread / float(seller_unit) if seller_unit else 0.0)
    if buyer_kwh is not None or buyer_unit is not None:
        return (2, basis_rank, 0.0)
    return (0, 0, 0.0)


def _last_touch(buyer: dict[str, Any], as_of: str) -> str:
    value = buyer.get("last_touch")
    if not value:
        return ""
    return value[:10] if value[:10] <= as_of else ""


def rank_a1(
    listing: dict[str, Any],
    buyers: list[dict[str, Any]],
    as_of: str,
    top: int = 30,
    body_fallback: bool = True,
) -> list[dict[str, Any]]:
    kept: list[dict[str, Any]] = []
    for buyer in buyers:
        out = rule_out(listing, buyer)
        if out:
            continue
        kept.append(buyer)
    ranked = []
    for buyer in kept:
        tier = product_tier(listing, buyer, as_of, body_fallback=body_fallback)
        price = _price_key(listing, buyer)
        ranked.append({
            "company_id": buyer["id"],
            "name": buyer["name"],
            "product_tier": tier,
            "price_fit": price[0],
            "price_basis": price[1],
            "price_margin": price[2],
            "stage": buyer.get("stage"),
            "basis": buyer.get("basis"),
            "last_touch": _last_touch(buyer, as_of),
            "is_lead": is_lead(buyer),
        })
    ranked.sort(key=lambda r: (
        -r["product_tier"],
        -r["price_fit"],
        -r["price_basis"],
        -r["price_margin"],
        -STAGE_RANK.get(r["stage"] or "", 0),
        _last_touch_key(r["last_touch"]),
        r["company_id"],
    ))
    return ranked[:top]


def _last_touch_key(value: str) -> int:
    """Newest first; an empty last touch sorts last."""
    if not value:
        return 10**12
    try:
        return -int(value.replace("-", "")[:8])
    except ValueError:
        return 10**12
