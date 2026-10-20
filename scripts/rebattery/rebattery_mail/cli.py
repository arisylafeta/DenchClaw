"""Command registry. Each module exposes register(subparsers); handlers are set with set_defaults(handler=...)."""

from __future__ import annotations

import argparse
import sys

from . import core

MODULES = (
    "identity", "template", "read", "sync", "backfill", "attachment", "draft", "campaign", "send", "followup", "legacy",
)


def build_parser():
    parser = argparse.ArgumentParser(prog="rebattery-mail", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in MODULES:
        try:
            module = __import__(f"rebattery_mail.{name}", fromlist=["register"])
        except ModuleNotFoundError as exc:
            if exc.name == f"rebattery_mail.{name}":
                continue  # module not built yet
            raise
        module.register(sub)
    return parser


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    return core.run(args.handler, args)


if __name__ == "__main__":
    sys.exit(main())
