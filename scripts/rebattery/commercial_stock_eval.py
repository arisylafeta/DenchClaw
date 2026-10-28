#!/usr/bin/env python3
"""Live, read-only evaluation of the commercial-buyer stock search (REB-577).

Runs a fixed set of buyer-style searches against /api/commercial-buyer/stock and prints one line per case:
groups, units, the top groups and whether the case's expectation held. Use it before and after search changes:

    python3 scripts/rebattery/commercial_stock_eval.py [--url https://crm.rebattery.io] [--json out.json]
    python3 scripts/rebattery/commercial_stock_eval.py --local   # this checkout's code against the local CRM database

The bearer secret is read from COMMERCIAL_STOCK_SECRET_FILE (default: the workspace secret file) and never printed.
"""
import argparse
import json
import os
import subprocess
import sys
import urllib.request

SECRET_FILE = os.environ.get("COMMERCIAL_STOCK_SECRET_FILE", "/root/.hermes/workspace/secrets/commercial-stock-api.secret")

# (name, filters, expectation). Expectation keys: min_groups, max_groups, label_has (any top-5 label contains),
# no_label_has (no returned label contains), max_units.
CASES = [
    ("make alias VW", {"make": "VW", "format": "pack"}, {"min_groups": 10, "label_has": "Volkswagen"}),
    ("ID3 without dot", {"make": "Volkswagen", "model": "ID3"}, {"min_groups": 1, "label_has": "ID.3"}),
    ("ID.3", {"make": "Volkswagen", "model": "ID.3"}, {"min_groups": 1, "max_groups": 4}),
    ("e-Niro", {"model": "e-Niro"}, {"min_groups": 1}),
    ("Niro EV", {"model": "Niro EV"}, {"min_groups": 1}),
    ("Kona Electric", {"make": "Hyundai", "model": "Kona Electric"}, {"min_groups": 1}),
    ("Tesla Model 3", {"make": "Tesla", "model": "Model 3"}, {"min_groups": 1}),
    ("Model3 no space", {"make": "Tesla", "model": "Model3"}, {"min_groups": 1}),
    ("Zoé accent", {"model": "Zoé"}, {"min_groups": 1}),
    ("Renault ZOE", {"make": "Renault", "model": "ZOE"}, {"min_groups": 1}),
    ("Mercedes", {"make": "Mercedes", "format": "pack"}, {"min_groups": 1, "label_has": "Mercedes-Benz"}),
    ("LFP", {"chemistry": "LFP"}, {"min_groups": 1}),
    ("LiFePO4 = LFP", {"chemistry": "LiFePO4"}, {"min_groups": 10}),
    ("NMC packs, no cell lots", {"chemistry": "NMC"}, {"min_groups": 1, "max_units": 20000}),
    ("modules", {"format": "module"}, {"min_groups": 1}),
    ("cells", {"format": "cell"}, {"min_groups": 1}),
    ("60-65 kWh packs", {"kwhMin": 60, "kwhMax": 65, "format": "pack"}, {"min_groups": 1}),
    ("PHEV", {"powertrain": "PHEV"}, {"min_groups": 1}),
    ("plug-in hybrid = PHEV", {"powertrain": "plug-in hybrid"}, {"min_groups": 10}),
    ("Electric = BEV", {"powertrain": "Electric"}, {"min_groups": 10}),
    ("Germany", {"country": "Germany"}, {"min_groups": 1}),
    ("DE = Germany only", {"country": "DE"}, {"min_groups": 1, "max_groups": 120}),
    ("Deutschland", {"country": "Deutschland"}, {"min_groups": 1}),
    ("UK = United Kingdom", {"country": "UK"}, {"min_groups": 50}),
    ("Stellantis group", {"make": "Stellantis"}, {"min_groups": 10}),
    ("MEB platform", {"model": "MEB"}, {"min_groups": 3, "label_has": "ID."}),
    ("Peugeot e-208", {"make": "Peugeot", "model": "e-208"}, {"min_groups": 1}),
    ("Peugeot 208", {"make": "Peugeot", "model": "208"}, {"min_groups": 1}),
    ("Kia Niro 60-70 kWh merges", {"make": "Kia", "model": "Niro", "kwhMin": 60, "kwhMax": 70}, {"min_groups": 1, "max_groups": 6}),
    ("Ioniq 5 / EV6 75-80 kWh", {"make": "Hyundai", "model": "Ioniq 5", "kwhMin": 75, "kwhMax": 80}, {"min_groups": 1, "max_groups": 3, "no_label_has": "Hyundai Hyundai"}),
    ("EV6 via fits", {"model": "EV6"}, {"min_groups": 1}),
    ("typo Ionic 5", {"model": "Ionic 5"}, {"min_groups": 1}),
    ("nonsense gives suggestions", {"model": "Zorblax"}, {"max_groups": 0}),
]


def search(url, secret, filters):
    body = json.dumps({**filters, "limit": 50, "scope": "eval-reb577"}).encode()
    request = urllib.request.Request(f"{url}/api/commercial-buyer/stock", data=body, method="POST",
                                     headers={"authorization": f"Bearer {secret}", "content-type": "application/json"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)


def local_search_all(filters_list):
    """Run every case through apps/web/scripts/commercial-stock-local-search.ts in one process."""
    web = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "apps", "web")
    lines = "".join(json.dumps({**filters, "limit": 50, "scope": "eval-reb577"}) + "\n" for filters in filters_list)
    out = subprocess.run(["pnpm", "exec", "tsx", "scripts/commercial-stock-local-search.ts"], cwd=web, input=lines,
                         capture_output=True, text=True, check=True, timeout=600).stdout
    return [json.loads(line) for line in out.splitlines() if line.startswith("{")]


def check(result, expect):
    labels = [group["label"] for group in result["groups"]]
    failures = []
    if result["totalGroups"] < expect.get("min_groups", 0):
        failures.append(f"groups<{expect['min_groups']}")
    if "max_groups" in expect and result["totalGroups"] > expect["max_groups"]:
        failures.append(f"groups>{expect['max_groups']}")
    if "max_units" in expect and result["totalUnits"] > expect["max_units"]:
        failures.append(f"units>{expect['max_units']}")
    if "label_has" in expect and not any(expect["label_has"].lower() in label.lower() for label in labels[:5]):
        failures.append(f"no '{expect['label_has']}' in top 5")
    if "no_label_has" in expect and any(expect["no_label_has"].lower() in label.lower() for label in labels):
        failures.append(f"'{expect['no_label_has']}' present")
    return failures


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="https://crm.rebattery.io")
    parser.add_argument("--json")
    parser.add_argument("--local", action="store_true")
    args = parser.parse_args()
    local = local_search_all([filters for _, filters, _ in CASES]) if args.local else None
    secret = None if args.local else open(SECRET_FILE).read().strip()
    passed, rows = 0, []
    for index, (name, filters, expect) in enumerate(CASES):
        try:
            result = local[index] if local is not None else search(args.url, secret, filters)
        except Exception as error:  # noqa: BLE001 - report and continue
            print(f"ERR  {name:28} {type(error).__name__}")
            rows.append({"name": name, "error": type(error).__name__})
            continue
        failures = check(result, expect)
        passed += not failures
        top = "; ".join(f"{g['label']} ({g['units']}u/{g['sources']}s)" for g in result["groups"][:3])
        hint = f" | suggestions: {', '.join(result.get('suggestions') or [])}" if not result["groups"] and result.get("suggestions") else ""
        print(f"{'PASS' if not failures else 'FAIL'} {name:28} g={result['totalGroups']:4} u={result['totalUnits']:6} | {top}{hint}"
              + (f"  <- {', '.join(failures)}" if failures else ""))
        rows.append({"name": name, "filters": filters, "failures": failures, "totalGroups": result["totalGroups"],
                     "totalUnits": result["totalUnits"], "top": [g["label"] for g in result["groups"][:5]],
                     "suggestions": result.get("suggestions")})
    print(f"\n{passed}/{len(CASES)} passed")
    if args.json:
        with open(args.json, "w") as handle:
            json.dump(rows, handle, indent=1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
