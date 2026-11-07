# Matches Phase 1 replay

Offline replay for the Matches 2.0 pipeline in `BUILD-PLAN.md` ("Matching
pipeline"). It runs 14 historical supply lots through four arms and writes a
metrics file plus a report. No Postgres writes, no email, no WhatsApp.

## Arms

| Arm | What it does |
| --- | --- |
| A0 | Today's logic: `apps/web/lib/buyer-suggestions.ts` (`scoreBuyer`, `compareBuyers`, `isLead`) over `crm_companies.buyer_profile`. |
| A1 | New rules layer: rule out only on a conflict both sides state, then order by product specificity, price band fit, stage and last contact. Top 30. |
| B0 | One caseworker call over A1's top 30, using `buyer_profile` JSON, stage and tier only. |
| B1 | The same call, but the ten pilot buyers get their as-of dossier frontmatter and filtered body instead of the flat profile. |

## Inputs

All data stays outside git. Pass paths explicitly:

```bash
/usr/bin/python3 scripts/rebattery/match_replay/build_pool.py \
  --out /path/to/replay/pool.json

/usr/bin/python3 scripts/rebattery/match_replay/run_replay.py \
  --cases /path/to/replay/cases.verified.json \
  --pool /path/to/replay/pool.json \
  --dossiers /path/to/buyer-dossiers-pilot \
  --replay-dir /path/to/replay \
  --arms A0,A1,B0,B1
```

`build_pool.py` reads `crm_companies` (buyer_profile not empty, no exclusion
reason) and the last `mail_message` touch through `crm_people.person_id`. It
opens the connection read-only.

## Leakage control

`dossier.py` builds an as-of view for each dossier:

- frontmatter `products` and `price` rows are kept only when `seen` is strictly
  before the offer date;
- dated body lines and dated "Bought from us" items on or after the offer date
  are dropped;
- "Open threads and promises" and "Sources" are dropped;
- `conflicts` and `last_verified` are dropped from the frontmatter view because
  they routinely restate later evidence.

Undated prose in "How to win them" and "Deal-killers" can still describe later
events. The report records that as a caveat.

A1 reads the as-of frontmatter first. Pilot product rows are dated at payment or
quote, not first ask, so a strict frontmatter-only view loses buyers whose ask
predates the offer. When the frontmatter yields no product match, A1 falls back
to product keywords in the filtered body and dated `past_asks`. This is a
harness concession, noted in the report; it does not read post-dated lines.

## Parity

`a0_parity.ts` imports the real `apps/web/lib/buyer-suggestions.ts` and runs it
under `node --experimental-strip-types`. The runner compares the TypeScript
output with the Python A0 port on every case and buyer and fails if they differ.

## Caseworker

`caseworker.py` posts one request per case per arm to
`http://127.0.0.1:8642/v1/chat/completions` with model `hermes-agent`,
temperature 0 and a 300 s timeout, one retry. The key comes from
`HERMES_API_KEY` or `API_SERVER_KEY` in `/root/.hermes/.env`; it is never
printed. Raw responses are cached in `<replay-dir>/cache/<arm>_<case>.json`;
rerunning only fetches missing entries. Invalid company ids are dropped.

The system prompt requires one JSON object, no tools and no contact with
anyone. It asks for 5 to 8 ranked buyers, each with a cited one-line reason, a
likely deal-killer and one question.

## Metrics

`run_replay.py` writes `outputs/metrics.json` with recall@5/@8/@30 over cases
that have at least one won, bid or asked buyer, the mean rank of the first
expected buyer, top-5 researched-only leads, rule violations against an as-of
dossier, and per-case ranks. Deal-killer judgement is manual and is read from
an optional `judgements.json` so no company-specific judgement lives in code.

## Files

- `build_pool.py` read-only pool snapshot
- `dossier.py` frontmatter/body as-of filter
- `rules.py` A0 port and A1 rules
- `a0_parity.ts` real TypeScript scorer for the parity check
- `caseworker.py` gateway call, cache and output validation
- `run_replay.py` orchestrator and metrics
