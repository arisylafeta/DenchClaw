"""The SQL (migration 121) and TypeScript twins of model_aliases.json are generated; they must not drift from it."""
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import model_aliases as ma  # noqa: E402


def test_generated_files_match_the_json():
    assert ma.drift() == [], "run scripts/rebattery/model_aliases.py --write"


def test_a_changed_json_value_is_caught(monkeypatch):
    monkeypatch.setitem(ma.MAKE_ALIASES, "zz", "zzmake")
    assert str(ma.MIGRATION) in ma.drift()
    assert str(ma.TS_PATH) in ma.drift()


def test_a_hand_edited_sql_word_list_is_caught():
    text = ma.MIGRATION.read_text(encoding="utf-8")
    assert ma.render_migration(text) == text
    assert ma.render_migration(text.replace("'vauxhall' then 'opel'", "'vauxhall' then 'opelx'")) == text
    assert ma.render_migration(text.replace("'se'\n", "'se', 'zz'\n")) == text


def test_make_aliases_and_words_are_in_the_sql_and_ts_twins():
    sql = ma.MIGRATION.read_text(encoding="utf-8")
    ts = ma.TS_PATH.read_text(encoding="utf-8")
    for alias, make in ma.MAKE_ALIASES.items():
        assert f"when '{alias}' then '{make}'" in sql
        assert f'"{alias}": "{make}"' in ts
    for word in ma.BRAND_WORDS + ma.VARIANT_WORDS:
        assert f"'{word}'" in sql and f'"{word}"' in ts


def test_one_key_blocks_are_in_migration_124_and_ts():
    sql = ma.MIGRATION_124.read_text(encoding="utf-8")
    ts = ma.TS_PATH.read_text(encoding="utf-8")
    for spelling, make in ma.KEY_MAKES.items():
        assert f"when '{spelling}' then '{make}'" in sql
        assert f'"{spelling}": "{make}"' in ts
    for (make, model), variants in ma.KWH_VARIANTS.items():
        for kwh in variants:
            assert f"('{make}', '{model}', {kwh})" in sql
    assert ma.render_migration(sql, ma._BLOCKS_124) == sql
    assert ma.render_migration(sql.replace("when 'lgchem' then 'lg'", "when 'lgchem' then 'lgx'"), ma._BLOCKS_124) == sql


def test_a_changed_variant_is_caught(monkeypatch):
    monkeypatch.setitem(ma.KWH_VARIANTS, ("kia", "niro"), (39.2, 64.8, 99.9))
    assert str(ma.MIGRATION_124) in ma.drift()


def test_snap_kwh_follows_the_variant_list():
    assert ma.snap_kwh("kia", "niro", 64) == 64.8 and ma.snap_kwh("kia", "niro", 39) == 39.2
    assert ma.snap_kwh("tesla", "model3", 80) == 78  # tie: the lower variant
    assert ma.snap_kwh("tesla", "model3", 70) == 70  # 5 kWh from any variant: unchanged
    assert ma.snap_kwh("fpt", "ebs37", 37) == 36.9
    assert ma.snap_kwh("foo", "bar", 50.04) == 50.0
    assert ma.kwh_text(ma.snap_kwh("foo", "bar", 77.0)) == "77"
    assert ma.canonical_make_slug("FPT Industrial") == ma.canonical_make_slug("Iveco FPT") == "fpt"
    assert ma.canonical_make_slug("LG Chem") == "lg" and ma.canonical_make_slug("Tesla") is None
