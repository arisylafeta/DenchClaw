#!/usr/bin/env python3
"""Relay attachment reader: the text of the files on an email thread, for the draft's background.

Run by the CRM (lib/relay-context.ts) as: relay_attachments.py <mail_message id> [<mail_message id> ...]
Message ids come newest first. Prints {"files": [...]}: each real file (not a signature image) with its text when it
is a PDF, Word, Excel, CSV, text or calendar file, else the reason it was not read. Bytes come from Gmail through
`rebattery-mail attachment` (read-only) into a temporary folder that is removed again; only the result is kept, one
small JSON per message in CACHE, because a stored email's files never change. Nothing here writes mail or the CRM.
A file's text is untrusted: the CRM passes it to the drafter as information, never as instructions.
"""
from __future__ import annotations

import csv
import html
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path

CLI = "/usr/local/bin/rebattery-mail"
CACHE = Path(os.environ.get("RELAY_ATTACHMENT_CACHE", "/srv/rebattery-data/relay-attachments"))
MAX_READ = 4            # files read per thread
MAX_LISTED = 8          # files named but not read
MAX_CHARS = 6000        # text kept per file
MAX_BYTES = 15 << 20    # larger files are named, not downloaded
MAX_UNPACKED = 60 << 20  # a Word or Excel file that unpacks past this is not opened
LOGO_BYTES = 8000       # a smaller picture is a signature logo or icon, not something sent to be looked at
BANNER_BYTES = 200_000  # a picture under this that repeats down the thread is a signature banner
BUDGET_SECONDS = 60

READERS = {"pdf": "pdf", "docx": "docx", "xlsx": "xlsx", "xlsm": "xlsx", "csv": "csv", "tsv": "csv", "txt": "text", "ics": "ics"}
IMAGES = {"png", "jpg", "jpeg", "jfif", "gif", "heic", "webp", "bmp", "tif", "tiff", "svg"}
ICS_KEYS = ("SUMMARY", "DTSTART", "DTEND", "LOCATION", "ORGANIZER", "DESCRIPTION")


def extension(name: str) -> str:
    return name.rsplit(".", 1)[-1].lower() if "." in name else ""


def real_files(attachments: list[dict]) -> list[dict]:
    """The attached files someone meant to send: no inline images, no signature logos, no nameless MIME parts."""
    return [a for a in attachments if isinstance(a, dict) and not a.get("inline") and a.get("filename")
            and extension(a["filename"]) and a["filename"].lower() not in ("noname", "attachment")
            and not (extension(a["filename"]) in IMAGES and 0 < int(a.get("sizeBytes") or 0) < LOGO_BYTES)]


def tidy(text: str, limit: int = MAX_CHARS) -> tuple[str, bool]:
    """Layout padding squeezed out, cut at limit. Returns (text, truncated)."""
    text = re.sub(r"[ \t ]{3,}", "  ", text.replace("\r", "").replace("\x00", ""))
    text = re.sub(r"\n[ \t]*(\n[ \t]*)+", "\n\n", "\n".join(line.rstrip() for line in text.split("\n"))).strip()
    return (text[:limit].rstrip(), True) if len(text) > limit else (text, False)


def unpacked_size(path: Path) -> int:
    with zipfile.ZipFile(path) as archive:
        return sum(info.file_size for info in archive.infolist())


def read_pdf(path: Path) -> str:
    result = subprocess.run(["/usr/bin/pdftotext", "-layout", "-l", "8", str(path), "-"], capture_output=True, timeout=30)
    return result.stdout.decode("utf-8", "replace") if result.returncode == 0 else ""


def read_docx(path: Path) -> str:
    if unpacked_size(path) > MAX_UNPACKED:
        return ""
    with zipfile.ZipFile(path) as archive:
        xml = archive.read("word/document.xml").decode("utf-8", "replace")
    xml = re.sub(r"</w:p>|<w:br[^>]*/>", "\n", re.sub(r"<w:tab[^>]*/>|</w:tc>", "\t", xml))
    return html.unescape(re.sub(r"<[^>]+>", "", xml))


def read_xlsx(path: Path) -> str:
    if unpacked_size(path) > MAX_UNPACKED:
        return ""
    from openpyxl import load_workbook
    book = load_workbook(path, read_only=True, data_only=True)
    out, size = [], 0
    try:
        for sheet in book.worksheets[:4]:
            out.append(f"[Sheet: {sheet.title}]")
            for index, row in enumerate(sheet.iter_rows(values_only=True)):
                if index >= 400 or size > MAX_CHARS * 2:
                    break
                cells = ["" if value is None else str(value).strip() for value in row]
                while cells and not cells[-1]:
                    cells.pop()
                if any(cells):
                    line = " | ".join(cells)
                    out.append(line)
                    size += len(line)
    finally:
        book.close()
    return "\n".join(out)


def read_csv(path: Path) -> str:
    raw = path.read_bytes()[: MAX_CHARS * 8].decode("utf-8-sig", "replace")
    try:
        dialect = csv.Sniffer().sniff(raw[:2000], delimiters=",;\t|")
    except csv.Error:
        return raw
    return "\n".join(" | ".join(cell.strip() for cell in row) for row in csv.reader(io.StringIO(raw), dialect) if any(cell.strip() for cell in row))


def read_text(path: Path) -> str:
    return path.read_bytes()[: MAX_CHARS * 8].decode("utf-8", "replace")


def read_ics(path: Path) -> str:
    """The lines of a calendar invite that say what, when, where and who."""
    lines = re.sub(r"\r?\n[ \t]", "", read_text(path)).splitlines()
    kept = [line for line in lines if line.split(":", 1)[0].split(";", 1)[0].upper() in ICS_KEYS]
    return "\n".join(line[:400] for line in kept[:12])


def extract(path: Path, name: str) -> dict:
    """{"read": True, "text", "truncated"} or {"read": False, "why"}. Never raises: a bad file is just not read."""
    reader = READERS.get(extension(name))
    try:
        raw = {"pdf": read_pdf, "docx": read_docx, "xlsx": read_xlsx, "csv": read_csv, "text": read_text, "ics": read_ics}[reader](path)
    except Exception:  # noqa: BLE001 - malformed or hostile files of every kind land here
        return {"read": False, "why": "could not be opened"}
    text, truncated = tidy(raw)
    if len(re.sub(r"\s", "", text)) < 20:
        return {"read": False, "why": "no readable text (a scan or a picture)" if reader == "pdf" else "empty"}
    return {"read": True, "text": text, "truncated": truncated}


def plan(attachments: list[dict], reads_left: int) -> list[dict]:
    """What to do with one message's files: read the first reads_left readable ones, name the rest with the reason."""
    files, seen = [], set()
    for a in real_files(attachments):
        name, size = a["filename"], int(a.get("sizeBytes") or 0)
        if name.lower() in seen:
            continue
        seen.add(name.lower())
        ext = extension(name)
        entry = {"filename": name, "size_bytes": size, "read": False}
        if ext in IMAGES:
            entry["why"] = "a picture, not read"
        elif ext not in READERS:
            entry["why"] = f".{ext} files are not read"
        elif size > MAX_BYTES:
            entry["why"] = "too large to read"
        elif reads_left <= 0:
            entry["why"] = "not read (enough files already)"
        else:
            # Gmail is asked by name; two parts with one name can only be told apart by id.
            names = [str(other.get("filename") or "").lower() for other in attachments if isinstance(other, dict)]
            entry["fetch"] = name if names.count(name.lower()) == 1 else a.get("attachmentId") or name
            reads_left -= 1
        files.append(entry)
    return files


def cli_json(*args: str, timeout: int = 60) -> dict | None:
    try:
        result = subprocess.run([CLI, "attachment", *args], capture_output=True, text=True, timeout=timeout)
        return json.loads(result.stdout) if result.returncode == 0 else None
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None


def read_message(message_id: str, reads_left: int, deadline: float) -> tuple[list[dict], bool]:
    """One message's files, and whether the answer is complete enough to keep (nothing failed on the way)."""
    listed = cli_json("list", "--", message_id)
    attachments = (listed or {}).get("attachments")
    if not isinstance(attachments, list):
        return [], False
    files, complete = plan(attachments, reads_left), True
    with tempfile.TemporaryDirectory(prefix="relay-att-") as folder:
        for index, entry in enumerate(files):
            selector = entry.pop("fetch", None)
            if not selector:
                continue
            out = Path(folder) / f"{index}.{extension(entry['filename'])}"
            got = cli_json("get", "--out", str(out), "--", message_id, selector) if time.monotonic() < deadline else None
            if not got or not out.is_file():
                entry["why"], complete = "could not be downloaded just now", False
                continue
            entry.update(extract(out, entry["filename"]))
    return files, complete


def cached(message_id: str) -> list[dict] | None:
    try:
        return json.loads((CACHE / f"{message_id}.json").read_text())["files"]
    except (OSError, ValueError, KeyError):
        return None


def store(message_id: str, files: list[dict]) -> None:
    try:
        CACHE.mkdir(parents=True, exist_ok=True)
        os.chmod(CACHE, 0o700)
        tmp = CACHE / f"{message_id}.json.part"
        tmp.write_text(json.dumps({"files": files}))
        os.chmod(tmp, 0o600)
        os.replace(tmp, CACHE / f"{message_id}.json")
    except OSError:
        pass  # the cache only saves time


def main(message_ids: list[str]) -> int:
    if not message_ids or any(not re.fullmatch(r"[A-Za-z0-9_:.@-]{1,120}", m) for m in message_ids):
        return 2
    deadline, found, out, reads, named = time.monotonic() + BUDGET_SECONDS, [], [], 0, 0
    for message_id in message_ids[:6]:
        files = cached(message_id)
        if files is None:
            if time.monotonic() >= deadline:
                break
            # A full read is kept whatever this thread's allowance, so the cache answers every later draft the same way.
            files, complete = read_message(message_id, MAX_READ, deadline)
            if complete:
                store(message_id, files)
        found.append((message_id, files))
    # The same picture on several of the thread's emails rides in someone's signature.
    pictures = [(e["filename"].lower(), e.get("size_bytes")) for _, files in found for e in files
                if extension(e["filename"]) in IMAGES and (e.get("size_bytes") or 0) < BANNER_BYTES]
    for message_id, files in found:
        for entry in files:
            if pictures.count((entry["filename"].lower(), entry.get("size_bytes"))) > 1:
                continue
            if entry.get("read") and reads >= MAX_READ:
                entry = {"filename": entry["filename"], "size_bytes": entry.get("size_bytes"), "read": False, "why": "not read (enough files already)"}
            if entry.get("read"):
                reads += 1
            elif named >= MAX_LISTED:
                continue
            else:
                named += 1
            out.append({**entry, "message_id": message_id})
    print(json.dumps({"files": out}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
