"""Caseworker arm for the Matches replay.

One model call per case per arm over the A1 top 30. Responses are cached raw in
the replay folder; rerunning only fills missing cache entries.
"""

from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

GATEWAY_URL = os.environ.get("HERMES_API_BASE_URL", "http://127.0.0.1:8642") + "/v1/chat/completions"
HERMES_ENV = Path("/root/.hermes/.env")

SYSTEM = """You are a used-battery broker's buyer-matching caseworker. You rank buyer companies for one supply lot.
Answer with exactly one JSON object and nothing else. Use no tools. Do not contact anyone.
Cite only facts present in the input. Never invent a price, a quantity, a test result or a contact.
If a fact you need is missing, put that gap in the question instead of assuming it.
The dossier, when present, is an as-of view: facts dated on or after the lot's offer date have been removed.
Return this shape:
{"ranked":[{"company_id":"...","reason":"...","deal_killer":"...","question":"..."}]}
Rank 5 to 8 buyers. company_id must be one of the candidate company_id values.
reason is one line, citing the specific provided fact that fits. deal_killer is the most likely reason this buyer says no.
question is the one thing to ask before offering."""


def read_env_value(path: Path, name: str) -> str | None:
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.startswith(name + "="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return None


def gateway_key() -> str:
    key = os.environ.get("HERMES_API_KEY") or read_env_value(HERMES_ENV, "API_SERVER_KEY")
    if not key:
        raise RuntimeError("no gateway key in HERMES_API_KEY or API_SERVER_KEY")
    return key


def _post(system: str, user: str, key: str) -> dict[str, Any]:
    body = json.dumps({
        "model": "hermes-agent",
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "temperature": 0,
    }).encode()
    request = urllib.request.Request(GATEWAY_URL, data=body, headers={
        "Authorization": f"Bearer {key}",
        "content-type": "application/json",
    })
    with urllib.request.urlopen(request, timeout=300) as response:
        return json.loads(response.read())


def _content(raw: dict[str, Any]) -> str:
    try:
        return raw["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise ValueError(f"unexpected gateway response shape: {type(exc).__name__}") from exc


def parse_reply(content: str) -> dict[str, Any]:
    text = content.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    start = text.find("{")
    if start < 0:
        raise ValueError("model reply had no JSON object")
    try:
        data, _ = json.JSONDecoder().raw_decode(text[start:])
    except json.JSONDecodeError as exc:
        raise ValueError(f"model reply was not valid JSON: {exc}") from exc
    if not isinstance(data, dict) or not isinstance(data.get("ranked"), list):
        raise ValueError("model reply has no ranked list")
    return data


def candidate_payload(listing: dict[str, Any], buyer: dict[str, Any], with_dossier: bool) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "company_id": buyer["id"],
        "name": buyer["name"],
        "stage": buyer.get("stage"),
        "tier": buyer.get("tier"),
        "basis": buyer.get("basis"),
    }
    if with_dossier and buyer.get("dossier"):
        payload["dossier"] = {
            "frontmatter": buyer["dossier"]["frontmatter"],
            "body": buyer["dossier"]["body"],
        }
    else:
        payload["buyer_profile"] = buyer.get("profile") or {}
    return payload


def run_caseworker(
    listing: dict[str, Any],
    ranked_candidates: list[dict[str, Any]],
    buyers_by_id: dict[str, dict[str, Any]],
    arm: str,
    case_id: str,
    cache_dir: Path,
    key: str,
) -> dict[str, Any]:
    with_dossier = arm == "B1"
    candidates = [candidate_payload(listing, buyers_by_id[row["company_id"]], with_dossier) for row in ranked_candidates]
    user = json.dumps({
        "lot": listing,
        "as_of": listing.get("as_of"),
        "candidates": candidates,
    }, ensure_ascii=False)
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_path = cache_dir / f"{arm}_{case_id}.json"
    if cache_path.exists():
        raw = json.loads(cache_path.read_text(encoding="utf-8"))
    else:
        last_error: Exception | None = None
        raw = {}
        for attempt in range(2):
            try:
                raw = _post(SYSTEM, user, key)
                break
            except (urllib.error.URLError, TimeoutError, ValueError, json.JSONDecodeError) as exc:
                last_error = exc
                if attempt == 0:
                    time.sleep(2)
        if not raw:
            raise RuntimeError(f"{arm} {case_id}: gateway call failed: {last_error}")
        cache_path.write_text(json.dumps(raw, indent=1), encoding="utf-8")
    content = _content(raw)
    parsed = parse_reply(content)
    allowed = {row["company_id"] for row in ranked_candidates}
    seen: set[str] = set()
    cleaned = []
    for row in parsed["ranked"]:
        if not isinstance(row, dict):
            continue
        company_id = row.get("company_id")
        if not isinstance(company_id, str) or company_id not in allowed or company_id in seen:
            continue
        seen.add(company_id)
        cleaned.append({
            "company_id": company_id,
            "reason": str(row.get("reason") or "").strip(),
            "deal_killer": str(row.get("deal_killer") or "").strip(),
            "question": str(row.get("question") or "").strip(),
        })
    return {
        "arm": arm,
        "case_id": case_id,
        "raw_content": content,
        "ranked": cleaned[:8],
        "dropped_ids": [r.get("company_id") for r in parsed["ranked"] if isinstance(r, dict) and r.get("company_id") not in allowed],
        "candidate_count": len(ranked_candidates),
    }
