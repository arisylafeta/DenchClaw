#!/usr/bin/env python3
"""Turn ranking_compare.sh output (old.json, new_on.json) into the old-vs-new top 10 report.
   ranking_compare_md.py <out-dir> <report.md> <branch-commit> <date>"""
import json, sys
from pathlib import Path

out_dir, report, commit, date = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3], sys.argv[4]
old, new = json.loads((out_dir / "old.json").read_text()), json.loads((out_dir / "new_on.json").read_text())
name = lambda row: row["name"]
cite = lambda row: " ".join(part for part in (row.get("reason") or "", "; ".join(c for c in row.get("checks", []) if c.startswith(("Buy box says", "Declined")))) if part)
lines = [
    "# Step 1c live ranking comparison: old top 10 vs new top 10", "",
    f"Date: {date}. Read-only against production (`default_transaction_read_only=on`). Branch `feat/interest-ranking` at `{commit}`. For each open supply listing "
    "(`crm_bulk_listing_supply_feed`) the real `supplyMatchesV2` ran three times: the origin/main build, the branch with `MATCH_BUYER_LINES=off`, and the branch with lines on. "
    "Flag off is byte-identical to origin/main on every listing (`cmp` of the full JSON). Ask rows (live demand) are part of the list in both, so the top 10 includes them.", "",
]
summary, beyond = [], []
for lid, entry in old.items():
    o, n = entry["result"], new[lid]["result"]
    orows, nrows = o["rows"], n["rows"]
    lines += [f"## {entry['title']}", f"`{lid}`. Lot key: {(n.get('lotKey') or {}).get('line')}. Rows: {len(orows)} old, {len(nrows)} new."]
    cited = sum(1 for row in nrows if any(c.startswith(("Buy box says", "Declined")) for c in row.get("checks", [])) or " Also: " in (row.get("reason") or "") or (row.get("reason") or "").startswith(("Bought:", "Ask:", "Standing want:", "Saved search:", "Interest:")))
    same = [(r["name"], r["reason"], r["checks"]) for r in orows] == [(r["name"], r["reason"], r["checks"]) for r in nrows]
    if same:
        lines += ["No change: same buyers, order, reasons and checks.", ""]
        summary.append((entry["title"], "no", cited)); continue
    summary.append((entry["title"], "yes", cited))
    top_o, top_n = {name(r) for r in orows[:10]}, {name(r) for r in nrows[:10]}
    lines += ["", "| # | Old top 10 | New top 10 |", "| --- | --- | --- |"]
    for i in range(10):
        a = orows[i]["name"] if i < len(orows) else ""; b = nrows[i]["name"] if i < len(nrows) else ""
        lines.append(f"| {i+1} | {'**'+a+'**' if a and a not in top_n else a} | {'**'+b+'**' if b and b not in top_o else b} |")
    lines += ["", "Bold = not in the other top 10.", ""]
    oi = {name(r): i + 1 for i, r in enumerate(orows)}
    moved = [f"- {name(r)}: {oi.get(name(r), 'not listed')} to {i+1}. {cite(r)}" + (f" Price: {r['price']}" if r.get("price") else "")
             for i, r in enumerate(nrows[:10]) if oi.get(name(r)) != i + 1]
    if moved: lines += ["**Moved inside the top 10:**", *moved, ""]
    old_by = {name(r): r for r in orows}
    reworded = [f"- {name(r)} (row {i+1}): {cite(r)}" for i, r in enumerate(nrows[:10])
                if oi.get(name(r)) == i + 1 and (r.get("reason"), r.get("checks")) != (old_by[name(r)].get("reason"), old_by[name(r)].get("checks"))]
    if reworded: lines += ["**Same place, new reason or checks:**", *reworded, ""]
    changed = [f"- {name(r)}: {oi.get(name(r), 'not listed')} to {i+11}. {cite(r)}" for i, r in enumerate(nrows[10:30]) if oi.get(name(r)) != i + 11]
    gone = [name(r) for r in orows if name(r) not in {name(x) for x in nrows}]
    if changed or gone:
        beyond += [f"**{entry['title']}**", *changed, *([f"- Dropped out of the {len(nrows)}: {', '.join(gone)}"] if gone else []), ""]
if beyond: lines += ["", "## Beyond the top 10 (rows 11 to 30)", "", *beyond]
lines += ["## Summary", "", "| Listing | Changed | Rows citing a line or decline |", "| --- | --- | --- |", *[f"| {t} | {c} | {k} |" for t, c, k in summary], ""]
report.write_text("\n".join(lines))
print("wrote", report, sum(1 for _, c, _ in summary if c == "yes"), "of", len(summary), "listings changed")
