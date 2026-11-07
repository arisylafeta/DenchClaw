# Matches Phase 1 replay

Offline replay for the Matches 2.0 pipeline in `BUILD-PLAN.md` ("Matching
pipeline"). It runs 14 historical supply lots through five arms and writes a
metrics file plus a report. No Postgres writes, no email, no WhatsApp.

## Arms

| Arm | What it does |
| --- | --- |
| A0 | Today's logic: `apps/web/lib/buyer-suggestions.ts` (`scoreBuyer`, `compareBuyers`, `isLead`) over `crm_companies.buyer_profile`. |
| A1S | Strict rules layer: as-of dossier frontmatter only, no body keyword fallback. Top 30. |
| A1 | The same rules layer plus product keywords from dated body lines and dated `past_asks`. Top 30. |
| B0 | One caseworker call over A1's top 30, using `buyer_profile` JSON, stage, tier and basis only. |
| B1 | The same call over the same top 30, with strict as-of dossiers for the ten pilot buyers. |

## Inputs

All data stays outside git. Pass paths explicitly:

```bash
/usr/bin/python3 scripts/rebattery/match_replay/build_pool.py \
  --out /path/to/replay/pool.json \
  --include-dossier-dir /path/to/buyer-dossiers-pilot

/usr/bin/python3 scripts/rebattery/match_replay/run_replay.py \
  --cases /path/to/replay/cases.verified.json \
  --pool /path/to/replay/pool.json \
  --dossiers /path/to/buyer-dossiers-pilot \
  --replay-dir /path/to/replay \
  --outputs-dir /path/to/replay/outputs-v2 \
  --cache-dir /path/to/replay/cache-v2 \
  --arms A0,A1S,A1,B0,B1
```

`build_pool.py` reads `crm_companies` (buyer_profile not empty, no exclusion
reason) and the last `mail_message` touch through `crm_people.person_id`. It
opens the connection read-only. `--include-dossier-dir` also adds companies
that have a pilot dossier but an empty `buyer_profile` (Volta Robotics); that
simulates the phase 0 pool fix without changing production data.

## Leakage control

`dossier.py` builds a strict as-of view for each dossier:

- frontmatter `products` and `price` rows are kept only when `seen` is present
  and strictly before the offer date;
- a body line is kept only when it starts with an ISO date strictly before the
  offer date (an optional leading bullet is allowed); undated lines are
  dropped, section headings are the only exception;
- "Open threads and promises" and "Sources" are dropped;
- `conflicts` and `last_verified` are dropped from the frontmatter view because
  they routinely restate later evidence.

There is no prose fallback for undated text in any arm. A1's body-keyword look
reads the same filtered body, so it can only see dated, pre-offer lines.

Fields without dates (`rules_out`, `quantity`, `substitution`, `capability`,
`decision_speed`, `evidence_required`, `intent`, `logistics`) are still passed
through. They were written after the deals and are a remaining leakage risk,
noted in the report.

## Parity

`a0_parity.ts` imports the real `apps/web/lib/buyer-suggestions.ts` and runs it
under `node --experimental-strip-types`. The runner compares the TypeScript
output with the Python A0 port on every case and buyer and fails if they differ.

## Caseworker

`caseworker.py` posts one request per case per arm to
`http://127.0.0.1:8642/v1/chat/completions` with model `hermes-agent`,
temperature 0 and a 300 s timeout, two network attempts, sequentially. The key
comes from `HERMES_API_KEY` or `API_SERVER_KEY` in `/root/.hermes/.env`; it is
never printed. Raw responses are cached per attempt in
`<cache-dir>/<arm>_<case>.json`; rerunning only fetches missing entries.

The system prompt requires one JSON object, no tools and no contact with
anyone. It asks for 5 to 8 ranked buyers, each with a cited one-line reason, a
likely deal-killer and one question. After cleaning, unknown ids, duplicates
and rows with an empty or placeholder reason/deal-killer are rejected. If fewer
than five valid rows remain the caseworker re-asks once with an explicit
correction naming the allowed ids; any remaining shortfall is stored on the
case output and in `metrics.json.caseworker_shortfalls`.

## Metrics

`run_replay.py` writes `<outputs-dir>/metrics.json` with case recall@5/@8/@30
over cases that have at least one won, bid or asked buyer, buyer recall at the
same cutoffs, the mean rank of the first expected buyer both among found cases
and with a penalty rank of 31 when not found, top-5 researched-only leads, rule
violations against an as-of dossier, and per-case ranks. Deal-killer judgement
is manual and is read from an optional `judgements.json` so no company-specific
judgement lives in code.

## Files

- `build_pool.py` read-only pool snapshot, optional dossier-only buyers
- `dossier.py` strict frontmatter/body as-of filter
- `rules.py` A0 port and A1/A1S rules
- `a0_parity.ts` real TypeScript scorer for the parity check
- `caseworker.py` gateway call, cache, row validation and one retry
- `run_replay.py` orchestrator and metrics
