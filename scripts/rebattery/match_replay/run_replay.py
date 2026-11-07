"""Run the Phase 1 Matches replay end to end.

Arms:
  A0  today's buyer-suggestions.ts scorer, run through Node on the real TS
  A1  the new rules layer (BUILD-PLAN "Matching pipeline")
  B0  one caseworker call over A1's top 30, buyer_profile only
  B1  the same call, with as-of dossiers for the pilot buyers

All paths are arguments. The script writes outputs and caches only under the
replay directory; it never writes to Postgres.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

import caseworker
import dossier as dossier_mod
import rules

POSITIVE_OUTCOMES = {"won", "bid", "asked"}


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def dump_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=1, ensure_ascii=False), encoding="utf-8")


def load_dossiers(folder: Path) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for path in sorted(folder.glob("*.md")):
        if path.name.upper() in {"TEMPLATE.MD", "README.MD"}:
            continue
        try:
            front, _ = dossier_mod.split_frontmatter(path.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            continue
        company_id = front.get("company_id")
        if company_id:
            out[str(company_id)] = {"path": str(path), "company": front.get("company")}
    return out


def buyer_view(buyer: dict[str, Any], dossier_view: dict[str, Any] | None) -> dict[str, Any]:
    return {
        "id": buyer["id"],
        "name": buyer["name"],
        "profile": buyer.get("profile") or {},
        "stage": buyer.get("stage"),
        "tier": buyer.get("tier"),
        "basis": buyer.get("basis"),
        "last_touch": buyer.get("last_touch"),
        "dossier": dossier_view,
    }


def run_a0(cases: list[dict[str, Any]], buyers: list[dict[str, Any]], script: Path, out_dir: Path) -> dict[str, Any]:
    supplies = [{"id": case["id"], "profile": rules.a0_supply_profile(case["listing"])} for case in cases]
    payload = {"supplies": supplies, "buyers": buyers}
    input_path = out_dir / "a0_input.json"
    dump_json(input_path, payload)
    result = subprocess.run(
        ["node", "--experimental-strip-types", str(script), str(input_path)],
        check=True, capture_output=True, text=True,
    )
    ts = json.loads(result.stdout)
    ts_by_case = ts["supplies"]

    out: dict[str, Any] = {}
    parity: dict[str, Any] = {"ok": True, "cases": {}}
    for case in cases:
        supply = rules.a0_supply_profile(case["listing"])
        py_rows = rules.a0_rank(supply, buyers)
        py_ids = [row["company_id"] for row in py_rows]
        ts_ids = ts_by_case.get(case["id"], [])
        same = py_ids == ts_ids
        parity["cases"][case["id"]] = {"same": same, "python": len(py_ids), "typescript": len(ts_ids)}
        if not same:
            parity["ok"] = False
            first_diff = next((i for i, (a, b) in enumerate(zip(py_ids, ts_ids)) if a != b), min(len(py_ids), len(ts_ids)))
            parity["cases"][case["id"]]["first_diff"] = {
                "index": first_diff,
                "python": py_ids[first_diff:first_diff + 3],
                "typescript": ts_ids[first_diff:first_diff + 3],
            }
        rows = []
        for index, row in enumerate(py_rows):
            rows.append({**row, "rank": index + 1})
        out[case["id"]] = {"ranked": rows, "scored": len(py_rows)}
    dump_json(out_dir / "a0.json", {"cases": out})
    dump_json(out_dir / "parity.json", parity)
    if not parity["ok"]:
        raise RuntimeError("A0 Python port does not match apps/web/lib/buyer-suggestions.ts")
    return out


def run_a1(
    cases: list[dict[str, Any]],
    buyers: list[dict[str, Any]],
    dossiers: dict[str, dict[str, Any]],
    out_dir: Path,
) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for case in cases:
        as_of = case["as_of"]
        views = []
        for buyer in buyers:
            view = None
            if buyer["id"] in dossiers:
                view = dossier_mod.load_dossier(dossiers[buyer["id"]]["path"], as_of)
            views.append(buyer_view(buyer, view))
        rows = rules.rank_a1(case["listing"], views, as_of, top=30)
        for index, row in enumerate(rows):
            row["rank"] = index + 1
        out[case["id"]] = {"ranked": rows}
    dump_json(out_dir / "a1.json", {"cases": out})
    return out


def run_b(
    cases: list[dict[str, Any]],
    buyers: list[dict[str, Any]],
    dossiers: dict[str, dict[str, Any]],
    a1: dict[str, Any],
    out_dir: Path,
    cache_dir: Path,
    arms: list[str],
) -> dict[str, Any]:
    key = caseworker.gateway_key()
    by_id = {buyer["id"]: buyer for buyer in buyers}
    out: dict[str, Any] = {}
    for arm in arms:
        arm_out: dict[str, Any] = {}
        for case in cases:
            as_of = case["as_of"]
            views = []
            for buyer in buyers:
                view = None
                if buyer["id"] in dossiers:
                    view = dossier_mod.load_dossier(dossiers[buyer["id"]]["path"], as_of)
                views.append(buyer_view(buyer, view))
            views_by_id = {view["id"]: view for view in views}
            ranked = a1[case["id"]]["ranked"]
            result = caseworker.run_caseworker(
                {"as_of": as_of, **case["listing"]},
                ranked,
                views_by_id,
                arm,
                case["id"],
                cache_dir,
                key,
            )
            rows = []
            for index, row in enumerate(result["ranked"]):
                rows.append({
                    **row,
                    "rank": index + 1,
                    "name": by_id[row["company_id"]]["name"],
                    "is_lead": rules.is_lead(views_by_id[row["company_id"]]),
                })
            arm_out[case["id"]] = {
                "ranked": rows,
                "dropped_ids": result["dropped_ids"],
                "candidate_count": result["candidate_count"],
            }
        out[arm] = arm_out
        dump_json(out_dir / f"{arm.lower()}.json", {"cases": arm_out})
    return out


def expected_ids(cases: list[dict[str, Any]], buyers: list[dict[str, Any]]) -> tuple[dict[str, list[dict[str, Any]]], list[str]]:
    by_name = {rules.norm(buyer["name"]): buyer["id"] for buyer in buyers}
    mapped: dict[str, list[dict[str, Any]]] = {}
    missing: list[str] = []
    for case in cases:
        rows = []
        for item in case.get("expected", []):
            company = item["company"]
            company_id = by_name.get(rules.norm(company))
            if not company_id:
                missing.append(f"{case['id']}: {company}")
                continue
            rows.append({**item, "company_id": company_id})
        mapped[case["id"]] = rows
    return mapped, missing


def rank_of(rows: list[dict[str, Any]], company_id: str) -> int | None:
    for row in rows:
        if row["company_id"] == company_id:
            return row["rank"]
    return None


def compute_metrics(
    cases: list[dict[str, Any]],
    arms: dict[str, dict[str, Any]],
    expected: dict[str, list[dict[str, Any]]],
    buyers: list[dict[str, Any]],
    dossiers: dict[str, dict[str, Any]],
    judgements: dict[str, Any],
) -> dict[str, Any]:
    by_id = {buyer["id"]: buyer for buyer in buyers}
    metrics: dict[str, Any] = {"arms": {}, "missing_expected": []}
    positive_cases = [case for case in cases if any(e["outcome"] in POSITIVE_OUTCOMES for e in expected[case["id"]])]
    positive_buyers = sum(1 for case in cases for e in expected[case["id"]] if e["outcome"] in POSITIVE_OUTCOMES)
    for arm, arm_cases in arms.items():
        recalls = {5: 0, 8: 0, 30: 0}
        buyer_hits = {5: 0, 8: 0, 30: 0}
        first_ranks: list[int] = []
        not_found = 0
        leads_top5 = 0
        violations: list[dict[str, Any]] = []
        per_case = {}
        for case in cases:
            case_id = case["id"]
            rows = arm_cases[case_id]["ranked"]
            positives = [e for e in expected[case_id] if e["outcome"] in POSITIVE_OUTCOMES]
            ranks = {}
            for item in expected[case_id]:
                ranks[item["company"]] = {
                    "company_id": item["company_id"],
                    "outcome": item["outcome"],
                    "rank": rank_of(rows, item["company_id"]),
                }
            if positives:
                found = [rank_of(rows, e["company_id"]) for e in positives]
                found = [r for r in found if r is not None]
                if found:
                    first_ranks.append(min(found))
                else:
                    not_found += 1
                for k in recalls:
                    if any((rank_of(rows, e["company_id"]) or 10**6) <= k for e in positives):
                        recalls[k] += 1
                for k in buyer_hits:
                    buyer_hits[k] += sum(1 for e in positives if (rank_of(rows, e["company_id"]) or 10**6) <= k)
            top5 = rows[:5]
            leads_top5 += sum(1 for row in top5 if row.get("is_lead"))
            for row in rows:
                company_id = row["company_id"]
                if company_id not in dossiers:
                    continue
                view = buyer_view(
                    by_id[company_id],
                    dossier_mod.load_dossier(dossiers[company_id]["path"], case["as_of"]),
                )
                out = rules.rule_out(case["listing"], view)
                if out:
                    violations.append({
                        "case": case_id,
                        "company_id": company_id,
                        "name": row["name"],
                        "rank": row["rank"],
                        "rule": out[0],
                        "detail": out[1],
                    })
            per_case[case_id] = {
                "expected": ranks,
                "first_positive_rank": min([r for r in [rank_of(rows, e["company_id"]) for e in positives] if r], default=None) if positives else None,
                "top5_leads": sum(1 for row in top5 if row.get("is_lead")),
            }
        total = len(positive_cases)
        metrics["arms"][arm] = {
            "cases_with_positives": total,
            "recall@5": round(recalls[5] / total, 3) if total else None,
            "recall@8": round(recalls[8] / total, 3) if total else None,
            "recall@30": round(recalls[30] / total, 3) if total else None,
            "hits@5": recalls[5],
            "hits@8": recalls[8],
            "hits@30": recalls[30],
            "positive_buyers": positive_buyers,
            "buyer_recall@5": round(buyer_hits[5] / positive_buyers, 3) if positive_buyers else None,
            "buyer_recall@8": round(buyer_hits[8] / positive_buyers, 3) if positive_buyers else None,
            "buyer_recall@30": round(buyer_hits[30] / positive_buyers, 3) if positive_buyers else None,
            "buyer_hits@5": buyer_hits[5],
            "mean_first_positive_rank_found": round(sum(first_ranks) / len(first_ranks), 2) if first_ranks else None,
            "positive_cases_not_found_top30": not_found,
            "top5_leads_total": leads_top5,
            "top5_leads_mean": round(leads_top5 / len(cases), 2) if cases else None,
            "rule_violations": violations,
            "per_case": per_case,
        }
    metrics["positive_case_count"] = len(positive_cases)
    metrics["judgements"] = judgements
    return metrics


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cases", required=True)
    parser.add_argument("--pool", required=True)
    parser.add_argument("--dossiers", required=True)
    parser.add_argument("--replay-dir", required=True)
    parser.add_argument("--ts-script", default=str(Path(__file__).with_name("a0_parity.ts")))
    parser.add_argument("--arms", default="A0,A1,B0,B1")
    parser.add_argument("--judgements", default=None)
    args = parser.parse_args()

    replay_dir = Path(args.replay_dir)
    out_dir = replay_dir / "outputs"
    cache_dir = replay_dir / "cache"
    cases = load_json(Path(args.cases))["cases"]
    pool = load_json(Path(args.pool))["buyers"]
    dossiers = load_dossiers(Path(args.dossiers))
    arms_wanted = [a.strip().upper() for a in args.arms.split(",") if a.strip()]
    expected, missing = expected_ids(cases, pool)

    print(json.dumps({"cases": len(cases), "pool": len(pool), "dossiers": len(dossiers), "missing_expected": missing}))

    arms: dict[str, dict[str, Any]] = {}
    if "A0" in arms_wanted:
        arms["A0"] = run_a0(cases, pool, Path(args.ts_script), out_dir)
    if "A1" in arms_wanted:
        arms["A1"] = run_a1(cases, pool, dossiers, out_dir)
    b_arms = [a for a in arms_wanted if a in {"B0", "B1"}]
    if b_arms:
        if "A1" not in arms:
            arms["A1"] = load_json(out_dir / "a1.json")["cases"]
        arms.update(run_b(cases, pool, dossiers, arms["A1"], out_dir, cache_dir, b_arms))

    judgements = {}
    if args.judgements:
        judgements = load_json(Path(args.judgements))
    metrics = compute_metrics(cases, arms, expected, pool, dossiers, judgements)
    metrics["missing_expected"] = missing
    metrics["case_count"] = len(cases)
    dump_json(out_dir / "metrics.json", metrics)
    print(json.dumps({"metrics": str(out_dir / "metrics.json"), "arms": list(arms)}))


if __name__ == "__main__":
    main()
