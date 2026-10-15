#!/usr/bin/env python3
"""Daily Postmark -> DenchClaw suppressions only. --dry-run makes no CRM writes.

Install this script under the default Hermes profile's scripts directory and run
it with Hermes' Python. The campaign CLI uses the system Python with psycopg2.
Credentials come from the existing default-profile secret loader, never the job.
"""

import argparse
import os
from pathlib import Path
import sys


CAMPAIGN_CLI = Path("/root/.hermes/projects/denchclaw-postmark-sync/scripts/rebattery/rebattery-campaign.py")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    sys.path.insert(0, "/usr/local/lib/hermes-agent")
    import hermes_bootstrap  # noqa: F401 — canonical Hermes dependency bootstrap
    from hermes_cli.env_loader import load_hermes_dotenv
    from agent.secret_scope import get_secret

    load_hermes_dotenv(hermes_home="/root/.hermes")
    token = get_secret("POSTMARK_SERVER_TOKEN")
    if not token:
        raise SystemExit("POSTMARK_SERVER_TOKEN is missing from the approved Hermes secret source; no CRM writes performed")
    env = os.environ.copy()
    env["POSTMARK_SERVER_TOKEN"] = token
    env["DENCH_CAMPAIGN_DSN"] = "dbname=denchclaw"
    command = ["/usr/bin/python3", str(CAMPAIGN_CLI), "sync-suppressions", "--stream", "broadcast"]
    if not args.dry_run:
        command.append("--apply")
    os.execve(command[0], command, env)


if __name__ == "__main__":
    main()
