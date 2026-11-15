import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location("digest", Path(__file__).with_name("bulk_next_action_digest.py"))
digest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(digest)

TODAY = "2026-11-16"


def row(id, owner="Alex", action="Call", due=TODAY, **kw):
    return {"id": id, "kind": "supply", "owner": owner, "next_action": action, "next_due": due, "title": f"Lot {id}", "party": "Seller", **kw}


def test_groups_by_driver_and_sends_only_when_something_is_due():
    rows = [
        row("a1"), row("a2", due="2026-11-02"), row("a3", due="2026-11-20"), row("a4", action=None, due=None),
        row("s1", owner="Sean", due="2026-11-20"), row("s2", owner="Sean", action=None, due=None),
        row("u1", owner="", due="2026-11-10"),  # no driver: goes to Alex
        row("r1", owner="Ari", due=TODAY),       # Ari has no email yet: falls back to Alex
    ]
    out = digest.build_digests(rows, TODAY)
    assert set(out) == {"Alex"}  # Sean has nothing due today or overdue
    alex = out["Alex"]
    assert [r["id"] for r in alex["today"]] == ["a1", "r1"]
    assert [r["id"] for r in alex["overdue"]] == ["a2", "u1"]  # oldest first
    assert [r["id"] for r in alex["needs"]] == ["a4"]
    assert digest.subject(alex) == "Today: 2 due, 2 overdue"


def test_render_links_every_line_and_caps_overdue():
    group = {"today": [row("a1")], "overdue": [row(f"o{i}", due="2026-11-01") for i in range(10)], "needs": [row("n1", action=None, due=None)]}
    text, page = digest.render("Alex", group)
    assert "Due today (1)" in text and "Overdue (10)" in text and "Needs a next action (1)" in text
    assert "and 2 more in Today" in text
    assert digest.listing_url("a1") in text and digest.html.escape(digest.listing_url("n1")) in page
    assert "owner=Alex" in page
    assert page.count("<li") == 1 + 1 + 8 + 1


def test_html_escapes_listing_text():
    group = {"today": [row("x", action="<b>Ask</b> & go")], "overdue": [], "needs": []}
    _, page = digest.render("Alex", group)
    assert "<b>Ask</b>" not in page and "&lt;b&gt;Ask&lt;/b&gt; &amp; go" in page


def test_a_pending_send_is_never_retried_and_a_second_run_sends_nothing(tmp_path, monkeypatch, capsys):
    import json, sys
    monkeypatch.setattr(digest, "STATE", tmp_path / "sent.json")
    monkeypatch.setattr(digest, "load_rows", lambda conn: [row("a1"), row("s1", owner="Sean")])
    class Conn:
        def __enter__(self): return self
        def __exit__(self, *a): return False
    monkeypatch.setitem(sys.modules, "psycopg2", type("pg", (), {"connect": staticmethod(lambda dsn: Conn())}))
    sent = []
    def fake_send(to, *a):
        if to == "sean@rebattery.io":
            raise RuntimeError("timeout")
        sent.append(to); return "m1"
    monkeypatch.setattr(digest, "send", fake_send)
    argv = ["x", "--apply", "--today", TODAY, "--approved-by", "Alex"]
    monkeypatch.setattr(sys, "argv", argv)
    assert digest.main() == 1
    state = json.loads((tmp_path / "sent.json").read_text())
    assert state == {f"{TODAY}:alex@rebattery.io": "m1", f"{TODAY}:sean@rebattery.io": "pending"}
    capsys.readouterr()
    assert digest.main() == 0
    assert sent == ["alex@rebattery.io"]
    out = json.loads(capsys.readouterr().out)
    assert [e["skipped"] for e in out["emails"]] == ["already sent today", "an earlier send may have gone out; not retried"]


def test_apply_needs_a_named_approver(monkeypatch):
    import sys, pytest
    monkeypatch.setattr(sys, "argv", ["x", "--apply", "--today", TODAY])
    with pytest.raises(SystemExit):
        digest.main()
