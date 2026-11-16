"""Gate for marketplace sourcing requests: only a genuine bulk purchase becomes a Bulk Trades request.

A request passes when it is (1) big enough: at least 300 kWh, or a stated budget of at least EUR 20k, (2) a request
to buy batteries, not documents or a repair, and (3) from a real buyer: a well-formed, non-disposable address whose
domain receives mail. Anything else stays on the buyer's profile as interest only. A request whose size cannot be
worked out does not pass. Pure functions; the mail-domain check is injected so tests run offline.
"""
import re
import subprocess

MIN_KWH = 300
MIN_VALUE_EUR = 20_000
EUR_PER_KWH_ESTIMATE = 25  # used only to show an estimated value; it never lets a request through on its own
TO_EUR = {"EUR": 1.0, "GBP": 1.15, "USD": 0.86}
# The lower end of each quantity band on the request form: "More than 10 units" is at least 11.
BAND_FLOOR = {"one": 1, "few": 2, "many": 11}
DISPOSABLE = {"mailinator.com", "guerrillamail.com", "10minutemail.com", "tempmail.com", "temp-mail.org", "yopmail.com",
              "trashmail.com", "sharklasers.com", "getnada.com", "dispostable.com", "maildrop.cc", "throwawaymail.com"}
NOT_A_PURCHASE = re.compile(
    r"\b(safety data sheet|data ?sheet|msds|sds\b|un ?38\.?3|test summary|certificate of|user manual|wiring diagram|"
    r"repair (my|of)|fix my|refurbish my)", re.I)
EMAIL = re.compile(r"^[^@\s]+@([a-z0-9-]+\.)+[a-z]{2,}$", re.I)
ITEMS = re.compile(r"(\d[\d,]*)\s*(?:x\s*)?(packs?|units?|pcs|pieces|modules?|batteries|battery packs)\b", re.I)
KWH = re.compile(r"(\d+(?:[.,]\d+)?)\s*(k|m)wh\b", re.I)


def _num(value):
    try:
        return float(str(value).replace(",", "."))
    except (TypeError, ValueError):
        return None


def units(request):
    """The least number of items asked for, or None."""
    value = _num(request.get("quantity_value"))
    if value and value > 0:
        return value
    text = request.get("quantity_text") or ""
    match = re.search(r"\d[\d,.]*", text)
    if match and _num(match.group().replace(",", "")):
        return _num(match.group().replace(",", ""))
    # "Need 20 packs" in their words beats the form's band, as long as it fits the band they picked.
    floor = BAND_FLOOR.get(request.get("quantity"))
    for text in (request.get("wants"), request.get("details")):
        match = ITEMS.search(text or "")
        if match:
            count = _num(match.group(1).replace(",", ""))
            if count and (floor is None or count >= floor) and not (request.get("quantity") == "one" and count > 1):
                return count
    return floor


def kwh_per_unit(request):
    """kWh of one item: the searched kWh range (midpoint), else a kWh figure in the buyer's text."""
    filters = request.get("filters") or {}
    low, high = _num(filters.get("kwh_min")), _num(filters.get("kwh_max"))
    if low and high:
        return round((low + high) / 2, 1)
    for text in (request.get("capacity_text"), request.get("wants"), request.get("details"), filters.get("q")):
        match = KWH.search(text or "")
        if match and match.group(2).lower() == "k":
            return _num(match.group(1))
    return None


def stated_total_kwh(request):
    """A total the buyer wrote in MWh ("2 MWh of LFP"), which is not per item."""
    for text in (request.get("capacity_text"), request.get("wants"), request.get("details")):
        match = KWH.search(text or "")
        if match and match.group(2).lower() == "m":
            value = _num(match.group(1))
            return value * 1000 if value else None
    return None


def stated_value_eur(request, count):
    """The buyer's own budget in EUR: a per-kWh price times the kWh, a per-item price times the items, or a bare
    amount as the whole budget. None without a usable price."""
    price, rate = _num(request.get("target_price")), TO_EUR.get(request.get("target_currency"))
    if not price or price <= 1 or not rate:
        return None
    unit = (request.get("price_unit") or "").lower()
    if unit == "kwh":
        return None  # needs the kWh: worked out by size()
    if unit in ("pack", "cell", "module", "unit") and count:
        return price * count * rate
    return price * rate


def size(request):
    """{units, kwh_each, total_kwh, value_eur, value_basis, est_value_eur} with None where unknown."""
    count = units(request)
    each = kwh_per_unit(request)
    total = stated_total_kwh(request) or (count * each if count and each else None)
    value, basis = stated_value_eur(request, count), "buyer's budget"
    price, rate = _num(request.get("target_price")), TO_EUR.get(request.get("target_currency"))
    if (request.get("price_unit") or "").lower() == "kwh" and price and rate and total:
        value, basis = price * total * rate, "buyer's price per kWh"
    return {"units": count, "kwh_each": each, "total_kwh": round(total) if total else None,
            "value_eur": round(value) if value else None, "value_basis": basis if value else None,
            "est_value_eur": round(total * EUR_PER_KWH_ESTIMATE) if total else None}


def domain_has_mx(domain):
    try:
        out = subprocess.run(["dig", "+short", "+time=3", "+tries=1", "MX", domain], capture_output=True, text=True, timeout=8)
    except (OSError, subprocess.TimeoutExpired):
        return None  # cannot tell: do not block on it, the review catches it
    if out.returncode != 0:
        return None
    return bool(out.stdout.strip())


def check(request, has_mx=domain_has_mx):
    """(passes, reasons, size). Reasons say why it passed or every reason it did not."""
    measured = size(request)
    text = " ".join(str(request.get(k) or "") for k in ("wants", "details"))
    email = (request.get("email") or "").strip().lower()
    fails, passes = [], []

    if measured["total_kwh"] is None and measured["value_eur"] is None:
        fails.append("size unknown: no kWh and no budget")
    elif (measured["total_kwh"] or 0) >= MIN_KWH:
        passes.append(f"about {measured['total_kwh']:,} kWh (at least {MIN_KWH})")
    elif (measured["value_eur"] or 0) >= MIN_VALUE_EUR:
        passes.append(f"budget about EUR {measured['value_eur']:,} (at least EUR {MIN_VALUE_EUR:,})")
    else:
        bits = [f"{measured['total_kwh']:,} kWh" if measured["total_kwh"] else None,
                f"EUR {measured['value_eur']:,}" if measured["value_eur"] else None]
        fails.append(f"too small: {', '.join(b for b in bits if b)} (needs {MIN_KWH} kWh or EUR {MIN_VALUE_EUR:,})")

    if NOT_A_PURCHASE.search(text):
        fails.append("not a purchase: asks for documents, information or a repair")
    else:
        passes.append("asks to buy")

    if not EMAIL.match(email):
        fails.append("email is not a valid address")
    else:
        domain = email.split("@", 1)[1]
        if domain in DISPOSABLE:
            fails.append("disposable email address")
        else:
            mx = has_mx(domain)
            if mx is False:
                fails.append(f"{domain} does not receive mail")
            elif mx is None:
                passes.append("mail domain not checked")
            else:
                passes.append("email domain receives mail")
    return (not fails), (passes if not fails else fails), measured


def owner_for(measured):
    """Sean drives lots worth EUR 20k or more, Alex the rest."""
    value = measured.get("value_eur") or measured.get("est_value_eur") or 0
    return "Sean" if value >= MIN_VALUE_EUR else "Alex"
