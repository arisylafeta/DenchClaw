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
