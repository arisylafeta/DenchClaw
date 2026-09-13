import importlib.util
import io
import tempfile
import unittest
import zipfile
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("import_whatsapp_trade_evidence.py")
SPEC = importlib.util.spec_from_file_location("whatsapp_trade_evidence", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class WhatsAppTradeEvidenceTest(unittest.TestCase):
    def make_archive(self, chat_text: str, *, duplicate: bool = False) -> Path:
        self.temp_dir = tempfile.TemporaryDirectory()
        outer_path = Path(self.temp_dir.name) / "history.zip"
        inner_bytes = io.BytesIO()
        with zipfile.ZipFile(inner_bytes, "w") as inner:
            inner.writestr("_chat.txt", chat_text)
            inner.writestr("IMG-001.jpg", b"same-image")
        with zipfile.ZipFile(outer_path, "w") as outer:
            outer.writestr("Whatsapp trader history/WhatsApp Chat - Buyer One.zip", inner_bytes.getvalue())
            if duplicate:
                outer.writestr("Whatsapp trader history/WhatsApp Chat - Buyer One (1).zip", inner_bytes.getvalue())
        return outer_path

    def tearDown(self) -> None:
        if hasattr(self, "temp_dir"):
            self.temp_dir.cleanup()

    def test_parses_multiline_messages_and_attachment_hashes(self) -> None:
        archive = self.make_archive(
            "[04/12/2025, 16:35:22] Alex: First line\n"
            "continued detail\n"
            "[05/12/2025, 09:00:00] Buyer One: Reply\n"
        )

        evidence = MODULE.read_archive(archive, "Europe/London")

        self.assertEqual(evidence.source_sha256, MODULE.sha256_file(archive))
        self.assertEqual(len(evidence.messages), 2)
        self.assertEqual(evidence.messages[0].conversation, "Buyer One")
        self.assertEqual(evidence.messages[0].body, "First line\ncontinued detail")
        self.assertEqual(evidence.messages[0].occurred_at.isoformat(), "2025-12-04T16:35:22+00:00")
        self.assertEqual(len(evidence.attachments), 1)
        self.assertEqual(evidence.attachments[0].sha256, MODULE.sha256_bytes(b"same-image"))


    def test_deduplicates_repeated_exports_but_preserves_occurrences(self) -> None:
        archive = self.make_archive("[04/12/2025, 16:35:22] Alex: Hello\n", duplicate=True)

        evidence = MODULE.read_archive(archive, "Europe/London")

        self.assertEqual(len(evidence.messages), 1)
        self.assertEqual(evidence.messages[0].occurrence_count, 2)
        self.assertEqual(len(evidence.messages[0].occurrences), 2)
        self.assertEqual(len(evidence.attachments), 1)
        self.assertEqual(evidence.attachments[0].occurrence_count, 2)
        self.assertEqual(len(evidence.attachments[0].occurrences), 2)

    def test_ids_are_stable_for_repeated_imports(self) -> None:
        archive = self.make_archive("[04/12/2025, 16:35:22] Alex: Hello\n")

        first = MODULE.read_archive(archive, "Europe/London")
        second = MODULE.read_archive(archive, "Europe/London")

        self.assertEqual(first.messages[0].id, second.messages[0].id)
        self.assertEqual(first.attachments[0].id, second.attachments[0].id)
        self.assertNotEqual(first.messages[0].id, first.attachments[0].id)


if __name__ == "__main__":
    unittest.main()
