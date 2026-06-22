# CRM People Enrichment Orchestrator Prompt

Run as the orchestrator for CRM people enrichment, not as the default enricher.

The `/loop` plugin is only a scheduler. It will re-prompt the same session when idle. It does not create worker lanes for you. You must launch subagents yourself, track progress, and keep moving until the enrichment run is complete.

## Goal
- Work through all people listed in `people-scope.json` until every person reaches a terminal state of `done`, `unknown`, or `failed`.
- Update `people-progress.md` every iteration.
- Write `PEOPLE_ENRICHMENT_DONE` into `people-progress.md` only when every person is terminal.

## Production database context
- The live source database is local Postgres.
- Production database name: `denchclaw`.
- Default local access pattern: `psql -d denchclaw`.
- The main source table for this workflow is `public.crm_people`.
- Related company data lives in `public.crm_companies` if company context is needed.
- Current live `crm_people` columns are:
  - `id`
  - `full_name`
  - `first_name`
  - `last_name`
  - `email`
  - `company_id`
  - `created_at`
  - `updated_at`
  - `phone`
  - `job_title`
  - `linkedin_url`
  - `tags`
  - `notes`
  - `email_opted_out`

## Copy database context
- Never write enrichment results back into production `denchclaw`.
- Use a disposable copy database for this workflow.
- Copy database name: `denchclaw_people_copy`.
- If it does not exist yet, create it from local Postgres `denchclaw` before dispatching subagents.
- All enricher writes go to `denchclaw_people_copy`, not `denchclaw`.
- Use a dedicated staging table named `public.crm_people_enrichments` in the copy DB.
- The staging table should be keyed by `person_id` and use idempotent upserts.
- Create or validate this schema once before launching workers:
  - `person_id`
    type: `text primary key`
  - `job_title`
    type: `text`
  - `linkedin_url`
    type: `text`
  - `seniority`
    type: `text`
  - `department`
    type: `text`
  - `company_name`
    type: `text`
  - `company_domain`
    type: `text`
  - `location_city`
    type: `text`
  - `location_country`
    type: `text`
  - `evidence_url`
    type: `text`
  - `evidence_snippet`
    type: `text`
  - `confidence`
    type: `text` with allowed values `high|medium|low`
  - `confidence_reason`
    type: `text`
  - `enriched_at`
    type: `timestamptz`
  - `enriched_by_batch`
    type: `text`

## Control plane
- `people-scope.json`: immutable people scope input
- `people-enrichment-state.json`: orchestrator-owned checkpoint and state
- `people-progress.md`: human-readable runtime progress and completion marker
- `people-worker-prompt.md`: canonical worker instructions
- `people-batch-inputs/<batch-id>.json`: exact assigned batch inputs
- `people-accepted-results.jsonl`: optional append-only summary log if useful

## Output data contract for this workflow
- The enrichment target fields for each person are:
  - `job_title`
  - `linkedin_url`
  - `seniority`
  - `department`
  - `company_name`
  - `company_domain`
  - `location_city`
  - `location_country`
  - `evidence_url`
  - `evidence_snippet`
  - `confidence`
  - `confidence_reason`
- These fields are written into `crm_people_enrichments` in `denchclaw_people_copy`, not assumed to already exist in `crm_people`.

## Orchestrator-only rules
- The orchestrator owns all state mutation.
- Workers should write directly to the copy DB staging table for their assigned people.
- Workers should use **SearXNG as the ONLY enrichment source** (Apollo MCP is NOT available).
- Do not include large JSON state files inline in your replies; read them from disk when needed.
- Save each batch input before dispatch.
- Each subagent must only write its assigned `person_id`s.
- Require idempotent upserts by `person_id`.
- Do not assign the same person twice unless retrying stale or failed work.
- Keep the workflow simple: use strict worker rules and `unknown` instead of a verifier stage.

## Batch policy
- Batch size: up to 5 people.
- Launch 5 enricher subagents at a time when work is available.
- Each subagent handles up to 5 people.
- Stale `in_progress` timeout: 60 minutes.
- Max attempts per person: 3 total.

## Confidence policy
- Do not run a verifier stage.
- Use strict worker rules, SearXNG-only enrichment, and `unknown` instead of guessing.
- Accept that some rows may remain unknown in the copy DB.
- At the end, produce confidence summaries and confidence distribution from the copy DB.

## State model
- `pending`
- `in_progress`
- `done`
- `unknown`
- `failed`

Track at least:
- `person_id`
- `status`
- `attempt_count`
- `assigned_batch_id`
- `confidence`
- `error`

## people-progress.md requirements
- Keep these sections current:
  - Current phase
  - Counts by status
  - Last processed batches
  - Current blocker
  - Next action
  - Completed milestones
- Keep it short and operational.
- Add `PEOPLE_ENRICHMENT_DONE` only when the job is truly complete.

## Completion rule
- Continue until no person in scope remains in a non-terminal state.
- Completion for the loop plugin is file-based: stop when `PEOPLE_ENRICHMENT_DONE` exists in `people-progress.md`.
- After completion, summarize the copy DB with:
  - total enriched rows
  - counts by `confidence`
  - counts by `seniority`
  - counts by `department`
  - high-confidence decision-maker candidates
