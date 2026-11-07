#!/usr/bin/env python3
"""Load buyer dossiers into crm_companies.buyer_dossier and derive buyer_profile from them.

  python3 scripts/rebattery/load_buyer_dossiers.py PILOT/*.md                  # dry run: validation and the diff
  python3 scripts/rebattery/load_buyer_dossiers.py --dir PILOT --apply         # write, one transaction per company

Every file needs `company_id` in its frontmatter; that id is the target row. The dry run prints, per
company, what the stored buyer_profile would gain and lose; nothing is written without --apply, and
--apply refuses to run without an explicit --dsn so it can never fall back to the production CRM.

A write sets `crm.dossier_write = 'on'` for its own transaction (the guard trigger rejects any other
writer), bumps buyer_dossier_version, derives buyer_profile only when it changes, and reads the row
back before committing. The derive is the same one the app uses: `buyer_dossier.py` and
`apps/web/lib/buyer-dossier.ts` are pinned to the fixtures in fixtures/buyer_dossier/.
"""
import argparse
import json
import sys
from pathlib import Path

import buyer_dossier as bd

DEFAULT_DSN = "host=/var/run/postgresql dbname=denchclaw"


def files_from(args):
    """Every Markdown dossier given directly or found in a --dir, READMEs excluded, in path order."""
    paths = [Path(path) for path in args.files]
    for directory in args.dir:
        paths += sorted(path for path in Path(directory).glob("*.md") if path.name != "README.md")
    return paths


def read_company(cur, company_id):
    cur.execute("""select buyer_profile, buyer_dossier, buyer_dossier_version
                   from crm_companies where id = %s""", (company_id,))
    return cur.fetchone()


def _sorted(value):
    """Key-order-independent JSON, for "did the derived profile actually change" checks."""
    return json.dumps(value or {}, sort_keys=True, default=str)


def plan(path, cur):
    """(company_id, text, profile, passed_through, errors, current) for one file."""
    text = path.read_text(encoding="utf-8")
    frontmatter, _ = bd.parse(text)
    errors = bd.validate(frontmatter)
    company_id = str(frontmatter.get("company_id") or "").strip()
    if not company_id and not errors:
        errors = ["company_id: missing (the loader needs it in the frontmatter)"]
    if errors:
        return company_id, text, None, [], errors, None
    current = read_company(cur, company_id)
    if current is None:
        return company_id, text, None, [], [f"no crm_companies row {company_id}"], None
    profile, passed_through, _ = bd.merge_profile(current["buyer_profile"], frontmatter)
    return company_id, text, profile, passed_through, [], current


def write(cur, company_id, text, profile, expected_version):
    """Write one dossier inside the caller's transaction and read it back.

    `expected_version` is the version the dry run read: if another writer got there first the company
    is aborted rather than overwriting it, and buyer_profile is written only when the derived JSON
    actually changed, exactly as the app's saveDossier does.
    """
    cur.execute("select buyer_profile, buyer_dossier_version from crm_companies where id = %s for update", (company_id,))
    locked = cur.fetchone()
    if locked is None:
        raise RuntimeError(f"no crm_companies row {company_id}")
    current_version = int(locked["buyer_dossier_version"] or 0)
    if current_version != expected_version:
        raise RuntimeError(f"version moved from v{expected_version} to v{current_version}; re-run the dry run")
    profile_changed = _sorted(locked["buyer_profile"]) != _sorted(profile)
    cur.execute("select set_config('crm.dossier_write', 'on', true)")
    cur.execute("""update crm_companies set
        buyer_dossier = %s,
        buyer_dossier_version = buyer_dossier_version + 1,
        buyer_dossier_updated_at = now(),
        buyer_profile = case when %s then %s::jsonb else buyer_profile end,
        updated_at = now()
      where id = %s""", (text, profile_changed, json.dumps(profile), company_id))
    cur.execute("""select buyer_dossier, buyer_profile, buyer_dossier_version
                   from crm_companies where id = %s""", (company_id,))
    saved = cur.fetchone()
    if saved["buyer_dossier"] != text:
        raise RuntimeError(f"read-back mismatch for {company_id}")
    if profile_changed and saved["buyer_profile"] != profile:
        raise RuntimeError(f"read-back mismatch for {company_id}")
    return saved["buyer_dossier_version"], profile_changed


def main(argv=None):
    import psycopg2
    import psycopg2.extras

    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("files", nargs="*", help="dossier Markdown files")
    parser.add_argument("--dir", action="append", default=[], help="a directory of dossier Markdown files")
    parser.add_argument("--dsn", help=f"database to read or write (default for a dry run: {DEFAULT_DSN}); "
                                      "required with --apply")
    parser.add_argument("--apply", action="store_true", help="write; without it nothing is saved")
    args = parser.parse_args(argv)

    paths = files_from(args)
    if not paths:
        parser.error("no dossier files (pass files or --dir)")
    if args.apply and not args.dsn:
        # A write must name its database: the default DSN here is the production CRM.
        parser.error("--apply needs an explicit --dsn")
    dsn = args.dsn or DEFAULT_DSN

    conn = psycopg2.connect(dsn)
    checked = changed = applied = 0
    failed = []
    try:
        for path in paths:
            checked += 1
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                company_id, text, profile, passed_through, errors, current = plan(path, cur)
            conn.rollback()  # end the read; the write below gets its own transaction per company
            if errors:
                failed.append(path)
                print(f"{path.name}: {len(errors)} error(s), nothing written")
                for error in errors:
                    print(f"  {error}")
                continue
            if current["buyer_dossier"] == text:
                print(f"{path.name}: {company_id} · already loaded (same text), skipped")
                continue
            diff = bd.diff_profiles(current["buyer_profile"] or {}, profile)  # type: ignore[index]
            version = current["buyer_dossier_version"] or 0
            state = "new" if current["buyer_dossier"] is None else f"replaces v{version}"
            print(f"{path.name}: {company_id} · {state} · {len(passed_through)} pass-through key(s)")
            if passed_through:
                print(f"  kept as they are: {', '.join(passed_through)}")
            if diff:
                changed += 1
                for line in bd.diff_lines(diff):
                    print(f"  {line}")
            else:
                print("  no change to buyer_profile")
            if args.apply:
                try:
                    with conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                        new_version, profile_changed = write(cur, company_id, text, profile, int(version))
                    applied += 1
                    print(f"  written: v{new_version}, read back"
                          f"{'' if profile_changed else ', buyer_profile unchanged'}")
                except Exception as error:  # one company's failure must not stop the rest
                    conn.rollback()
                    failed.append(path)
                    print(f"  FAILED: {error}")
    finally:
        conn.close()

    verb = "wrote" if args.apply else "would write"
    print(f"{'applied' if args.apply else 'dry run'}: {checked} file(s), {changed} with a buyer_profile change, "
          f"{verb} {applied if args.apply else changed}, {len(failed)} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
