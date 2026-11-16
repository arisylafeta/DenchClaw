#!/usr/bin/env python3
"""Canonical model slugs: the Python twin of apps/web/lib/match/model-aliases.ts and of the SQL function
buyer_interest_model_slug() in migration 115. The JSON next to the TS module is the one list all three read.

  model_aliases.py --slug "Hyundai" "Kona Electric"     # prints kona
  model_aliases.py --sql                                # prints the CREATE FUNCTION text migration 115 holds
"""
import argparse
import json
import re
import unicodedata
from pathlib import Path

ALIASES_PATH = Path(__file__).resolve().parents[2] / "apps" / "web" / "lib" / "match" / "model-aliases.json"
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


def sql_function():
    """The migration text for buyer_interest_model_slug(), generated so the SQL cannot drift from the JSON."""
    values = ",\n    ".join(
        "('{}', '{}', '{}', {})".format(own, alias.replace("'", "''"), slug, "true" if is_global else "false")
        for own, alias, slug, is_global in sorted(ALIAS_ROWS))
    return f"""create or replace function buyer_interest_model_slug(p_make text, p_model text) returns text language plpgsql immutable as $fn$
declare
  raw text := coalesce(p_model, '');
  txt text;
  norm text;
  brand text;
  spaced text;
  tokens text[];
  mk text := nullif(buyer_interest_fold(p_make), '');
  best text;
  exact_only boolean := position('/' in coalesce(p_model, '')) > 0;
  pass int;
  variants text[] := array['long', 'range', 'standard', 'awd', 'rwd', 'fwd', '4wd', '2wd', 'lr', 'sr', 'dual', 'motor', 'performance', 'premium', 'se'];
begin
  if btrim(raw) = '' or raw ~ '[,;:]' then return null; end if;
  for pass in 1..2 loop
    txt := buyer_interest_unaccent(raw);
    txt := regexp_replace(txt, '\\y[0-9]+(\\.[0-9]+)?\\s*(kwh|kw|ps|hp|bhp|ah)\\y', ' ', 'g');
    txt := regexp_replace(txt, '\\([^)]*\\)|\\[[^\\]]*\\]', ' ', 'g');
    if pass = 1 then txt := regexp_replace(txt, '\\y(19|20)[0-9]{{2}}\\y', ' ', 'g'); end if;
    txt := regexp_replace(txt, '\\y(battery|batteries|packs?|modules?|hv|high voltage)\\y', ' ', 'g');
    txt := btrim(regexp_replace(regexp_replace(txt, '[^a-z0-9]+', ' ', 'g'), '\\s+', ' ', 'g'));
    for brand in
      select distinct b from unnest(array[btrim(regexp_replace(buyer_interest_unaccent(p_make), '[^a-z0-9]+', ' ', 'g')),
        {", ".join("'" + re.sub(r"[^a-z0-9]+", " ", b) + "'" for b in BRAND_WORDS)}]) b where b <> '' order by length(b) desc
    loop
      if txt like brand || ' %' then txt := substr(txt, length(brand) + 2); exit; end if;
    end loop;
    tokens := string_to_array(txt, ' ');
    while coalesce(array_length(tokens, 1), 0) > 1 and tokens[array_length(tokens, 1)] = any(variants) loop
      tokens := tokens[1:array_length(tokens, 1) - 1];
    end loop;
    norm := array_to_string(tokens, ' ');
    exit when norm <> '';
  end loop;
  if norm = '' then return null; end if;
  select slug into best from (values
    {values}
  ) a(own, alias, slug, is_global)
  where (norm = alias or (not exact_only and norm like alias || ' %'))
    and (own = mk or is_global)
  order by (own = mk) desc, length(alias) desc limit 1;
  if best is not null then return best; end if;
  if exact_only or coalesce(array_length(tokens, 1), 0) >= 4 then return null; end if;
  return nullif(regexp_replace(norm, '[^a-z0-9]+', '', 'g'), '');
end $fn$;"""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--slug", nargs=2, metavar=("MAKE", "MODEL"))
    parser.add_argument("--sql", action="store_true")
    args = parser.parse_args()
    if args.sql:
        print(sql_function())
    if args.slug:
        print(model_slug(*args.slug))


if __name__ == "__main__":
    main()
