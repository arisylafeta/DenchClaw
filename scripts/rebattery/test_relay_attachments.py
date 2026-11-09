import json
import zipfile
from pathlib import Path

import relay_attachments as ra


def att(name, size=100_000, inline=False, aid=None):
    return {"filename": name, "sizeBytes": size, "inline": inline, "attachmentId": aid or f"id-{name}", "mediaType": "x"}


def test_real_files_drops_signature_images_and_nameless_parts():
    kept = ra.real_files([att("image001.png", inline=True), att("Quote.pdf"), att("noname"), att("attachment"), {"filename": None}, "junk",
                          att("image001.gif", size=1567), att("logo.svg", size=3310), att("IMG_8239.JPG", size=3_445_982), att("notes.txt", size=300)])
    assert [a["filename"] for a in kept] == ["Quote.pdf", "IMG_8239.JPG", "notes.txt"]


def test_tidy_squeezes_layout_padding_and_cuts_at_the_limit():
    text, truncated = ra.tidy("Devis # S00245" + " " * 40 + "Date\r\n\n\n\n   \nTotal\x00  10.740,00")
    assert text == "Devis # S00245  Date\n\nTotal  10.740,00" and truncated is False
    assert ra.tidy("word " * 100, limit=50) == (("word " * 10).rstrip(), True)


def test_plan_reads_documents_and_names_the_rest_with_a_reason():
    files = ra.plan([att("Quote.pdf"), att("photo.JPG"), att("data.zip"), att("huge.pdf", size=ra.MAX_BYTES + 1), att("Stock.xlsx"), att("Terms.docx")], reads_left=2)
    assert [(f["filename"], f.get("fetch"), f.get("why")) for f in files] == [
        ("Quote.pdf", "Quote.pdf", None),
        ("photo.JPG", None, "a picture, not read"),
        ("data.zip", None, ".zip files are not read"),
        ("huge.pdf", None, "too large to read"),
        ("Stock.xlsx", "Stock.xlsx", None),
        ("Terms.docx", None, "not read (enough files already)"),
    ]


def test_plan_lists_a_name_used_twice_once_and_does_not_fetch_it():
    files = ra.plan([att("scan.pdf", aid="first"), att("scan.pdf", aid="second"), att("invite.ics"), att("invite.ics", inline=True)], reads_left=4)
    assert [(f["filename"], f.get("fetch"), f.get("why")) for f in files] == [
        ("scan.pdf", None, "not read (two files share this name)"), ("invite.ics", None, "not read (two files share this name)")]


def test_extract_reads_word_excel_csv_and_invites(tmp_path):
    docx = tmp_path / "terms.docx"
    with zipfile.ZipFile(docx, "w") as archive:
        archive.writestr("word/document.xml", "<w:document><w:p><w:r><w:t>Payment 30 days &amp; EXW Tienen</w:t></w:r></w:p><w:p><w:r><w:t>Second paragraph here</w:t></w:r></w:p></w:document>")
    assert ra.extract(docx, "terms.docx") == {"read": True, "text": "Payment 30 days & EXW Tienen\nSecond paragraph here", "truncated": False}

    from openpyxl import Workbook
    book = Workbook()
    book.active.title = "Stock"
    book.active.append(["Model", "kWh", "Qty", None])
    book.active.append([None, None, None, None])
    book.active.append(["Citroen C3 CC21", 28, 10, None])
    xlsx = tmp_path / "stock.xlsx"
    book.save(xlsx)
    assert ra.extract(xlsx, "stock.xlsx")["text"] == "[Sheet: Stock]\nModel | kWh | Qty\nCitroen C3 CC21 | 28 | 10"

    table = tmp_path / "prices.csv"
    table.write_text("model;price\nLeaf 40 kWh;1200\n\n")
    assert ra.extract(table, "prices.csv")["text"] == "model | price\nLeaf 40 kWh | 1200"

    invite = tmp_path / "invite.ics"
    invite.write_text("BEGIN:VEVENT\r\nUID:1\r\nSUMMARY:FPT call\r\nDTSTART;TZID=Europe/Rome:20261112T100000\r\nLOCATION:Teams\r\n meeting room\r\nEND:VEVENT\r\n")
    assert ra.extract(invite, "invite.ics")["text"] == "SUMMARY:FPT call\nDTSTART;TZID=Europe/Rome:20261112T100000\nLOCATION:Teamsmeeting room"


def test_extract_never_raises_and_says_why_nothing_was_read(tmp_path, monkeypatch):
    broken = tmp_path / "broken.xlsx"
    broken.write_bytes(b"not a zip")
    assert ra.extract(broken, "broken.xlsx") == {"read": False, "why": "could not be opened"}
    monkeypatch.setattr(ra.subprocess, "run", lambda *a, **k: type("R", (), {"returncode": 0, "stdout": b"  \n"})())
    assert ra.extract(tmp_path / "scan.pdf", "scan.pdf") == {"read": False, "why": "no readable text (a scan or a picture)"}


def test_a_bloated_office_file_is_not_opened(tmp_path, monkeypatch):
    monkeypatch.setattr(ra, "MAX_UNPACKED", 10)
    docx = tmp_path / "big.docx"
    with zipfile.ZipFile(docx, "w") as archive:
        archive.writestr("word/document.xml", "<w:p>" + "x" * 500 + "</w:p>")
    assert ra.extract(docx, "big.docx") == {"read": False, "why": "empty"}


def fake_cli(calls, lists, fail=(), broken=()):
    def cli_json(*args, timeout=60):
        calls.append(args)
        if args[0] == "list":
            return {"attachments": lists[args[-1]]} if args[-1] in lists else None
        message, name, out = args[-2], args[-1], Path(args[2])
        if name in fail:
            return None
        out.write_bytes(b"not a zip" if name in broken else f"Text of {name} on {message}, long enough to count as read.".encode())
        return {"path": str(out)}
    return cli_json


def test_main_reads_newest_first_within_the_allowance_and_caches_whole_answers(tmp_path, monkeypatch, capsys):
    calls = []
    lists = {"m2": [att("a.txt"), att("b.txt"), att("c.txt")], "m1": [att("d.txt"), att("e.txt"), att("photo.png")]}
    monkeypatch.setattr(ra, "CACHE", tmp_path / "cache")
    monkeypatch.setattr(ra, "cli_json", fake_cli(calls, lists))
    assert ra.main(["m2", "m1"]) == 0
    answer = json.loads(capsys.readouterr().out)
    files = answer["files"]
    assert answer["missed"] is False
    assert [(f["message_id"], f["filename"], f["read"]) for f in files] == [
        ("m2", "a.txt", True), ("m2", "b.txt", True), ("m2", "c.txt", True), ("m1", "d.txt", True), ("m1", "e.txt", False), ("m1", "photo.png", False)]
    assert files[0]["text"].startswith("Text of a.txt on m2") and "text" not in files[4] and files[4]["why"] == "not read (enough files already)"
    # Both messages were read in full and kept, so a second run asks Gmail nothing.
    calls.clear()
    assert ra.main(["m1"]) == 0
    again = json.loads(capsys.readouterr().out)["files"]
    assert calls == [] and [(f["filename"], f["read"]) for f in again] == [("d.txt", True), ("e.txt", True), ("photo.png", False)]


def test_main_does_not_cache_a_failed_download_and_reports_an_unlisted_message(tmp_path, monkeypatch, capsys):
    calls = []
    monkeypatch.setattr(ra, "CACHE", tmp_path / "cache")
    monkeypatch.setattr(ra, "cli_json", fake_cli(calls, {"m1": [att("a.txt"), att("b.txt")]}, fail={"b.txt"}))
    assert ra.main(["m1", "gone"]) == 0
    answer = json.loads(capsys.readouterr().out)
    assert [(f["filename"], f["read"], f.get("why")) for f in answer["files"]] == [("a.txt", True, None), ("b.txt", False, "could not be downloaded just now")]
    assert answer["missed"] is True
    assert not (tmp_path / "cache" / "m1.json").exists() and not (tmp_path / "cache" / "gone.json").exists()
    # Nothing could be listed at all: still an answer, and it says so.
    assert ra.main(["gone"]) == 0
    assert json.loads(capsys.readouterr().out) == {"files": [], "missed": True}


def test_main_says_so_when_time_runs_out_before_every_message_is_looked_at(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(ra, "CACHE", tmp_path / "cache")
    monkeypatch.setattr(ra, "BUDGET_SECONDS", 0)
    monkeypatch.setattr(ra, "cli_json", fake_cli([], {"m1": [att("a.txt")]}))
    assert ra.main(["m1"]) == 0
    assert json.loads(capsys.readouterr().out) == {"files": [], "missed": True}


def test_main_does_not_cache_a_file_that_would_not_open(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(ra, "CACHE", tmp_path / "cache")
    monkeypatch.setattr(ra, "cli_json", fake_cli([], {"m1": [att("stock.xlsx")]}, broken={"stock.xlsx"}))
    assert ra.main(["m1"]) == 0
    answer = json.loads(capsys.readouterr().out)
    assert [(f["filename"], f["read"], f["why"]) for f in answer["files"]] == [("stock.xlsx", False, "could not be opened")]
    assert not (tmp_path / "cache" / "m1.json").exists()


def test_main_rejects_missing_or_odd_ids():
    assert ra.main([]) == 2
    assert ra.main(["../etc/passwd"]) == 2
    assert ra.main(["ok", "bad id"]) == 2


def test_main_leaves_out_a_picture_repeated_across_the_thread(tmp_path, monkeypatch, capsys):
    lists = {"m3": [att("image.png", size=31_987), att("a.txt")], "m2": [att("image.png", size=31_987)], "m1": [att("image.png", size=27_959)]}
    monkeypatch.setattr(ra, "CACHE", tmp_path / "cache")
    monkeypatch.setattr(ra, "cli_json", fake_cli([], lists))
    assert ra.main(["m3", "m2", "m1"]) == 0
    files = json.loads(capsys.readouterr().out)["files"]
    assert [(f["message_id"], f["filename"]) for f in files] == [("m3", "a.txt"), ("m1", "image.png")]
