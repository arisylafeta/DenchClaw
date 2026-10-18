"""Synthetic retention fixtures, no customer source data."""
import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from rebattery_whatsapp.retention import erase_line, expired_lines
from rebattery_whatsapp.core import Refused


class RetentionTests(unittest.TestCase):
    def test_purge_preserves_append_offsets_and_replay_marker(self):
        with tempfile.TemporaryDirectory() as tmp:
            file = Path(tmp) / 'capture.jsonl'
            now = datetime.now(timezone.utc)
            old = {'capturedAt': (now - timedelta(days=31)).isoformat(), 'body': 'synthetic private text'}
            recent = {'capturedAt': now.isoformat(), 'body': 'synthetic fresh text'}
            file.write_text(json.dumps(old) + '\n' + json.dumps(recent) + '\n')
            inode, size = file.stat().st_ino, file.stat().st_size
            planned = list(expired_lines(tmp, now - timedelta(days=30)))
            self.assertEqual(len(planned), 1)
            with file.open('ab') as handle:
                handle.write(b'{"partial":')
            erase_line(*planned[0])
            self.assertEqual(file.stat().st_ino, inode)
            self.assertEqual(file.stat().st_size, size + len(b'{"partial":'))
            lines = file.read_bytes().splitlines()
            self.assertTrue(json.loads(lines[0])['retentionErased'])
            self.assertEqual(json.loads(lines[1]), recent)
            self.assertEqual(lines[2], b'{"partial":')
            self.assertNotIn(b'synthetic private text', file.read_bytes())
            self.assertEqual(list(expired_lines(tmp, now - timedelta(days=30))), [])

    def test_changed_source_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as tmp:
            file = Path(tmp) / 'capture.jsonl'
            file.write_text(json.dumps({'capturedAt': '2020-01-01T00:00:00Z', 'body': 'synthetic'}) + '\n')
            planned = list(expired_lines(tmp, datetime.now(timezone.utc)))
            file.write_text('replacement\n')
            with self.assertRaises(Refused):
                erase_line(*planned[0])
            self.assertEqual(file.read_text(), 'replacement\n')
