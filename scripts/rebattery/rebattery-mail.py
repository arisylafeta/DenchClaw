#!/usr/bin/env python3
"""rebattery-mail: read, search, draft, send and track all ReBattery mail. See rebattery_mail/cli.py."""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

try:
    import psycopg2  # noqa: F401
except ModuleNotFoundError:
    # Whichever python the caller used, find one that has the database driver and run again under it.
    for candidate in ("/usr/bin/python3", "/usr/local/lib/hermes-agent/venv/bin/python3"):
        if candidate != sys.executable and os.path.exists(candidate):
            os.execv(candidate, [candidate, *sys.argv])
    sys.exit("rebattery-mail: no python with psycopg2 found")

from rebattery_mail.cli import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
