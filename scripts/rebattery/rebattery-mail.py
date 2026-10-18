#!/usr/bin/env python3
"""rebattery-mail: read, search, draft, send and track all ReBattery mail. See rebattery_mail/cli.py."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from rebattery_mail.cli import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
