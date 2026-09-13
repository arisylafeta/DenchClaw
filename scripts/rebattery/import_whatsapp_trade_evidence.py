#!/usr/bin/env python3
"""Import WhatsApp trade exports as immutable local CRM evidence.

The importer stores text and attachment metadata in local Postgres. It never
extracts attachment files and never writes archive contents into Git.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
import zipfile
from datetime import datetime
from pathlib import Path
from typing import NamedTuple
from zoneinfo import ZoneInfo

BIDI_MARKS = "\u200e\u202a\u202c\ufeff"
MESSAGE_RE = re.compile(
    rf"^[{BIDI_MARKS}]*\[(?P<date>\d{{1,2}}/\d{{1,2}}/\d{{4}}),\s*(?P<time>\d{{1,2}}:\d{{2}}(?::\d{{2}})?)\]\s*(?P<sender>[^:]+):\s?(?P<body>.*)$"
)
DUPLICATE_EXPORT_SUFFIX_RE = re.compile(r"\s+\(\d+\)$")


class Message(NamedTuple):
    id: str
    source_member: str
    conversation: str
    message_index: int
    occurred_at: datetime
    sender: str
    body: str
    sha256: str
    occurrence_count: int
    occurrences: list[dict[str, int | str]]


class Attachment(NamedTuple):
    id: str
    source_member: str
    conversation: str
    archive_member: str
    filename: str
    size_bytes: int
    sha256: str
    occurrence_count: int
    occurrences: list[dict[str, str]]


class ArchiveEvidence(NamedTuple):
    source_id: str
    source_sha256: str
    messages: list[Message]
    attachments: list[Attachment]
    conversations: list[str]


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def stable_id(kind: str, *parts: object) -> str:
    material = "\x1f".join(str(part) for part in parts).encode("utf-8")
    return f"{kind}:{sha256_bytes(material)}"


def conversation_name(source_member: str) -> str:
    name = Path(source_member).stem
    prefix = "WhatsApp Chat - "
    if name.startswith(prefix):
        name = name[len(prefix):]
    return DUPLICATE_EXPORT_SUFFIX_RE.sub("", name).strip()


def parse_chat(
    text: str,
    *,
    source_id: str,
    source_member: str,
    conversation: str,
    timezone_name: str,
) -> list[Message]:
    timezone = ZoneInfo(timezone_name)
    parsed: list[tuple[str, str, str, datetime]] = []
    current: list[str] | None = None

    for raw_line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        line = raw_line.lstrip(BIDI_MARKS)
        match = MESSAGE_RE.match(line)
        if match:
            if current is not None:
                sender, body, occurred_iso = current[0], "\n".join(current[1:-1]), current[-1]
                parsed.append((sender, body, source_member, datetime.fromisoformat(occurred_iso)))
            timestamp_text = f"{match.group('date')} {match.group('time')}"
            timestamp_format = "%d/%m/%Y %H:%M:%S" if timestamp_text.count(":") == 2 else "%d/%m/%Y %H:%M"
            occurred_at = datetime.strptime(timestamp_text, timestamp_format).replace(tzinfo=timezone)
            current = [match.group("sender").strip(), match.group("body"), occurred_at.isoformat()]
        elif current is not None:
            current.insert(-1, raw_line)

    if current is not None:
        sender, body, occurred_iso = current[0], "\n".join(current[1:-1]), current[-1]
        parsed.append((sender, body, source_member, datetime.fromisoformat(occurred_iso)))

    messages: list[Message] = []
    for index, (sender, body, member, occurred_at) in enumerate(parsed):
        body = body.rstrip("\n")
        content_sha = sha256_bytes(
            f"{occurred_at.isoformat()}\x1f{sender}\x1f{body}".encode("utf-8")
        )
        messages.append(
            Message(
                id=stable_id("wam", source_id, member, index, content_sha),
                source_member=member,
                conversation=conversation,
                message_index=index,
                occurred_at=occurred_at,
                sender=sender,
                body=body,
                sha256=content_sha,
                occurrence_count=1,
                occurrences=[{"source_member": member, "message_index": index}],
            )
        )
    return messages


def read_archive(path: Path, timezone_name: str = "Europe/London") -> ArchiveEvidence:
    path = path.expanduser().resolve()
    source_sha = sha256_file(path)
    source_id = f"whatsapp:{source_sha}"
    messages: list[Message] = []
    attachments: list[Attachment] = []
    conversations: set[str] = set()

    with zipfile.ZipFile(path) as outer:
        inner_names = sorted(
            name for name in outer.namelist()
            if name.lower().endswith(".zip") and not name.startswith("__MACOSX/")
        )
        for inner_name in inner_names:
            conversation = conversation_name(inner_name)
            conversations.add(conversation)
            with zipfile.ZipFile(io.BytesIO(outer.read(inner_name))) as inner:
                members = sorted(
                    (
                        info for info in inner.infolist()
                        if not info.is_dir() and not info.filename.startswith("__MACOSX/")
                    ),
                    key=lambda info: info.filename,
                )
                chat_members = [info for info in members if info.filename.lower().endswith(".txt")]
                for info in chat_members:
                    text = inner.read(info).decode("utf-8-sig", errors="replace")
                    messages.extend(
                        parse_chat(
                            text,
                            source_id=source_id,
                            source_member=inner_name,
                            conversation=conversation,
                            timezone_name=timezone_name,
                        )
                    )
                for info in members:
                    if info in chat_members or Path(info.filename).name == ".DS_Store":
                        continue
                    content = inner.read(info)
                    content_sha = sha256_bytes(content)
                    attachments.append(
                        Attachment(
                            id=stable_id("waa", source_id, inner_name, info.filename, content_sha),
                            source_member=inner_name,
                            conversation=conversation,
                            archive_member=info.filename,
                            filename=Path(info.filename).name,
                            size_bytes=len(content),
                            sha256=content_sha,
                            occurrence_count=1,
                            occurrences=[{
                                "source_member": inner_name,
                                "conversation": conversation,
                                "archive_member": info.filename,
                            }],
                        )
                    )

    deduplicated_messages: list[Message] = []
    message_groups: dict[tuple[str, str], list[Message]] = {}
    for message in messages:
        message_groups.setdefault((message.conversation, message.sha256), []).append(message)
    for (conversation, content_sha), occurrences in sorted(message_groups.items()):
        occurrences.sort(key=lambda item: (item.source_member, item.message_index))
        first = occurrences[0]
        source_occurrences = [item.occurrences[0] for item in occurrences]
        deduplicated_messages.append(
            first._replace(
                id=stable_id("wam", source_id, conversation, content_sha),
                occurrence_count=len(source_occurrences),
                occurrences=source_occurrences,
            )
        )

    deduplicated_attachments: list[Attachment] = []
    attachment_groups: dict[str, list[Attachment]] = {}
    for attachment in attachments:
        attachment_groups.setdefault(attachment.sha256, []).append(attachment)
    for content_sha, occurrences in sorted(attachment_groups.items()):
        occurrences.sort(key=lambda item: (item.source_member, item.archive_member))
        first = occurrences[0]
        source_occurrences = [item.occurrences[0] for item in occurrences]
        deduplicated_attachments.append(
            first._replace(
                id=stable_id("waa", source_id, content_sha),
                occurrence_count=len(source_occurrences),
                occurrences=source_occurrences,
            )
        )

    return ArchiveEvidence(
        source_id=source_id,
        source_sha256=source_sha,
        messages=deduplicated_messages,
        attachments=deduplicated_attachments,
        conversations=sorted(conversations),
    )


def import_evidence(archive_path: Path, schema_path: Path, timezone_name: str) -> dict[str, int | str]:
    try:
        import psycopg2
        from psycopg2.extras import Json, execute_values
    except ImportError as error:
        raise SystemExit("psycopg2 is required to import evidence") from error

    evidence = read_archive(archive_path, timezone_name)
    connection = psycopg2.connect(host="/var/run/postgresql", dbname="denchclaw")
    try:
        with connection:
            with connection.cursor() as cursor:
                cursor.execute(schema_path.read_text())
                cursor.execute(
                    """INSERT INTO crm_trade_evidence_sources
                       (id, source_kind, source_path, source_sha256, metadata)
                       VALUES (%s, 'whatsapp_export', %s, %s, %s)
                       ON CONFLICT (id) DO NOTHING""",
                    (
                        evidence.source_id,
                        str(archive_path.expanduser().resolve()),
                        evidence.source_sha256,
                        Json({"timezone": timezone_name, "conversations": evidence.conversations}),
                    ),
                )
                execute_values(
                    cursor,
                    """INSERT INTO crm_trade_evidence_messages
                       (id, source_id, source_member, conversation, message_index,
                        occurred_at, sender, body, content_sha256, occurrence_count, occurrences)
                       VALUES %s ON CONFLICT (id) DO NOTHING""",
                    [
                        (
                            message.id, evidence.source_id, message.source_member,
                            message.conversation, message.message_index, message.occurred_at,
                            message.sender, message.body, message.sha256,
                            message.occurrence_count, Json(message.occurrences),
                        )
                        for message in evidence.messages
                    ],
                    page_size=500,
                )
                execute_values(
                    cursor,
                    """INSERT INTO crm_trade_evidence_attachments
                       (id, source_id, source_member, conversation, archive_member,
                        filename, size_bytes, content_sha256, occurrence_count, occurrences)
                       VALUES %s ON CONFLICT (id) DO NOTHING""",
                    [
                        (
                            attachment.id, evidence.source_id, attachment.source_member,
                            attachment.conversation, attachment.archive_member,
                            attachment.filename, attachment.size_bytes, attachment.sha256,
                            attachment.occurrence_count, Json(attachment.occurrences),
                        )
                        for attachment in evidence.attachments
                    ],
                    page_size=500,
                )
                cursor.execute(
                    "SELECT count(*) FROM crm_trade_evidence_messages WHERE source_id = %s",
                    (evidence.source_id,),
                )
                stored_messages = cursor.fetchone()[0]
                cursor.execute(
                    "SELECT count(*) FROM crm_trade_evidence_attachments WHERE source_id = %s",
                    (evidence.source_id,),
                )
                stored_attachments = cursor.fetchone()[0]
    finally:
        connection.close()

    return {
        "source_id": evidence.source_id,
        "conversations": len(evidence.conversations),
        "messages": stored_messages,
        "attachments": stored_attachments,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--timezone", default="Europe/London")
    parser.add_argument(
        "--schema",
        type=Path,
        default=Path(__file__).parents[2] / "apps/web/lib/crm-postgres/migrations/003_bulk_trade_observability.sql",
    )
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    result = import_evidence(args.archive, args.schema, args.timezone)
    if args.json:
        print(json.dumps(result, sort_keys=True))
    else:
        print(
            f"Imported {result['messages']} messages and {result['attachments']} attachments "
            f"from {result['conversations']} conversations."
        )


if __name__ == "__main__":
    main()
