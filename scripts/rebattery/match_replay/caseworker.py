"""Caseworker arm for the Matches replay.

One model call per case per arm over the A1 top 30. If the reply yields fewer
than five usable rows the caseworker asks once more with an explicit
correction, then records any remaining shortfall. Unknown or placeholder rows
are rejected. Responses are cached raw per attempt in the replay folder; a
rerun only fetches missing entries.
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
MIN_ROWS = 5
MAX_ROWS = 8

SYSTEM = """You are a used-battery broker's buyer-matching caseworker. You rank buyer companies for one supply lot.
Answer with exactly one JSON object and nothing else. Use no tools. Do not contact anyone.
Cite only facts present in the input. Never invent a price, a quantity, a test result or a contact.
If a fact you need is missing, put that gap in the question instead of assuming it.
The dossier, when present, is an as-of view: facts dated on or after the lot's offer date have been removed.
Return this shape:
{\"ranked\":[{\"company_id\":\"...\",\"reason\":\"...\",\"deal_killer\":\"...\",\"question\":\"...\"}]}
Return between 5 and 8 buyers. company_id must be one of the candidate company_id values.
reason is one line, citing the specific provided fact that fits. deal_killer is the most likely reason this buyer says no.
question is the one thing to ask before offering.
Every row needs a real, specific reason and deal_killer. Never write PLACEHOLDER, TBD or N/A."""


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


def _post(system: str, messages: list[dict[str, str]], key: str) -> dict[str, Any]:
    body = json.dumps({
        "model": "hermes-agent",
        "messages": [{"role": "system", "content": system}, *messages],
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


def _placeholder(text: str) -> bool:
    value = text.strip()
    if not value:
        return True
    upper = value.upper()
    return "PLACEHOLDER" in upper or upper in {"TBD", "N/A", "NONE", "UNKNOWN"}


def clean_rows(parsed: dict[str, Any], allowed: set[str]) -> dict[str, Any]:
    """Keep valid, unique, non-placeholder rows; cap at eight."""
    seen: set[str] = set()
    cleaned: list[dict[str, Any]] = []
    unknown: list[Any] = []
    rejected: list[dict[str, str]] = []
    for row in parsed["ranked"]:
        if not isinstance(row, dict):
            continue
        company_id = row.get("company_id")
        if not isinstance(company_id, str) or company_id not in allowed or company_id in seen:
            unknown.append(company_id)
            continue
        reason = str(row.get("reason") or "").strip()
        killer = str(row.get("deal_killer") or "").strip()
        if _placeholder(reason) or _placeholder(killer):
            rejected.append({"company_id": company_id, "why": "placeholder or empty reason/deal_killer"})
            continue
        seen.add(company_id)
        cleaned.append({
            "company_id": company_id,
            "reason": reason,
            "deal_killer": killer,
            "question": str(row.get("question") or "").strip(),
        })
    return {
        "ranked": cleaned[:MAX_ROWS],
        "over_cap": max(0, len(cleaned) - MAX_ROWS),
        "unknown_ids": unknown,
        "rejected_rows": rejected,
    }


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


def _correction(count: int, allowed_ids: list[str]) -> str:
    return (
        f"Your previous reply contained {count} usable ranked buyers. The minimum is {MIN_ROWS}. "
        f"Return between {MIN_ROWS} and {MAX_ROWS} ranked buyers now, using only these company_id values: "
        + ", ".join(allowed_ids)
        + ". Keep the same JSON shape. Every row needs a specific reason and deal_killer, no placeholder text."
    )


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
    allowed_ids = [row["company_id"] for row in ranked_candidates]
    allowed = set(allowed_ids)
    user = json.dumps({
        "lot": listing,
        "as_of": listing.get("as_of"),
        "candidates": candidates,
    }, ensure_ascii=False)
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_path = cache_dir / f"{arm}_{case_id}.json"
    attempts: list[dict[str, Any]] = []
    if cache_path.exists():
        cached = json.loads(cache_path.read_text(encoding="utf-8"))
        if isinstance(cached, dict) and isinstance(cached.get("attempts"), list):
            attempts = [item for item in cached["attempts"] if isinstance(item, dict)]
        elif isinstance(cached, dict):
            attempts = [cached]
    else:
        attempts = []

    best: dict[str, Any] | None = None
    best_count = -1
    retry_error: str | None = None

    def consider(raw: dict[str, Any]) -> None:
        nonlocal best, best_count
        parsed = parse_reply(_content(raw))
        result = clean_rows(parsed, allowed)
        if len(result["ranked"]) > best_count:
            best = result
            best_count = len(result["ranked"])

    for cached_raw in attempts:
        try:
            consider(cached_raw)
        except ValueError as exc:
            # A malformed cached attempt is ignored; a fetch below can replace it.
            retry_error = f"cached reply unusable: {exc}"

    while best_count < MIN_ROWS and len(attempts) < 2:
        messages = [{"role": "user", "content": user}]
        if attempts:
            messages = [
                {"role": "user", "content": user},
                {"role": "assistant", "content": _content(attempts[-1])},
                {"role": "user", "content": _correction(max(best_count, 0), allowed_ids)},
            ]
        last_error: Exception | None = None
        raw: dict[str, Any] = {}
        for attempt in range(2):
            try:
                raw = _post(SYSTEM, messages, key)
                break
            except (urllib.error.URLError, TimeoutError, ValueError, json.JSONDecodeError) as exc:
                last_error = exc
                if attempt == 0:
                    time.sleep(2)
        if not raw:
            if best is not None:
                retry_error = f"retry failed: {last_error}"
                break
            raise RuntimeError(f"{arm} {case_id}: gateway call failed: {last_error}")
        attempts.append(raw)
        cache_path.write_text(json.dumps({"attempts": attempts}, indent=1), encoding="utf-8")
        try:
            consider(raw)
        except ValueError as exc:
            if best is not None:
                retry_error = f"retry reply unusable: {exc}"
                break
            raise

    if best is None:
        raise RuntimeError(f"{arm} {case_id}: no usable caseworker reply")
    shortfall = max(0, MIN_ROWS - best_count)
    return {
        "arm": arm,
        "case_id": case_id,
        "raw_content": _content(attempts[-1]) if attempts else "",
        "ranked": best["ranked"],
        "over_cap": best["over_cap"],
        "dropped_ids": best["unknown_ids"],
        "rejected_rows": best["rejected_rows"],
        "candidate_count": len(ranked_candidates),
        "attempt_count": len(attempts),
        "shortfall": shortfall,
        "retry_error": retry_error,
    }
