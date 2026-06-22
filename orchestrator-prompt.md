# CRM Company Enrichment Orchestrator Prompt

Run as the orchestrator for CRM company enrichment, not as the default enricher.

The `/loop` plugin is only a scheduler. It will re-prompt the same session when idle. It does not create worker lanes for you. You must launch subagents yourself, track progress, and keep moving until the enrichment run is complete.

## Goal
- Work through all companies listed in `company-scope.json` until every company reaches a terminal state of `done`, `unknown`, `conflict`, or `failed`.
- Update `progress.md` every iteration.
- Write `CRM_ENRICHMENT_DONE` into `progress.md` only when every company is terminal.

## Production database context
- The live source database is local Postgres.
- Production database name: `denchclaw`.
- Default local access pattern: `psql -d denchclaw`.
- The main source table for this workflow is `public.crm_companies`.
- Related people data lives in `public.crm_people` if contact context is needed, but this workflow is enriching company rows first.
- Current live `crm_companies` columns are:
  - `id`
  - `name`
  - `domain`
  - `website`
  - `phone`
  - `linkedin_url`
  - `country`
  - `city`
  - `created_at`
  - `updated_at`
  - `notes`
  - `tags`

## Copy database context
- Never write enrichment results back into production `denchclaw`.
- Use a disposable copy database for this workflow.
- Copy database name: `denchclaw_enrichment_copy`.
- If it does not exist yet, create it from local Postgres `denchclaw` before dispatching subagents.
- All enricher writes go to `denchclaw_enrichment_copy`, not `denchclaw`.
- Use a dedicated staging table named `public.crm_company_enrichments` in the copy DB.
- The staging table should be keyed by `company_id` and use idempotent upserts.
- Create or validate this schema once before launching workers:
  - `company_id`
    type: `text primary key`
  - `domain`
    type: `text`
  - `country`
    type: `text`
  - `city`
    type: `text`
  - `about`
    type: `text`
  - `sectors`
    type: `text[]`
  - `roles`
    type: `text[]`
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
- `company-scope.json`: immutable company scope input
- `enrichment-state.json`: orchestrator-owned checkpoint and state
- `progress.md`: human-readable runtime progress and completion marker
- `worker-prompt.md`: canonical worker instructions
- `batch-inputs/<batch-id>.json`: exact assigned 3-company batch inputs
- `accepted-results.jsonl`: optional append-only summary log if useful

## Output data contract for this workflow
- The enrichment target fields for each company are:
  - `domain`
  - `country`
  - `city`
  - `about`
  - `sectors[]`
  - `roles[]`
  - `evidence_url`
  - `evidence_snippet`
  - `confidence`
  - `confidence_reason`
- These fields are written into `crm_company_enrichments` in `denchclaw_enrichment_copy`, not assumed to already exist in `crm_companies`.

## Orchestrator-only rules
- The orchestrator owns all state mutation.
- Workers should write directly to the copy DB staging table for their assigned companies.
- Workers should use SearXNG as their default open-web discovery path.
- Do not include large JSON state files inline in your replies; read them from disk when needed.
- Save each batch input before dispatch.
- Each subagent must only write its assigned `company_id`s.
- Require idempotent upserts by `company_id`.
- Do not assign the same company twice unless retrying stale or failed work.
- Keep the workflow simple: use strict worker rules and `unknown` instead of a verifier stage.

## Batch policy
- Batch size: up to 3 companies.
- Launch 10 enricher subagents at a time when work is available.
- Each subagent handles up to 3 companies.
- Stale `in_progress` timeout: 60 minutes.
- Max attempts per company: 3 total.

## Confidence policy
- Do not run a verifier stage.
- Use strict worker rules, SearXNG-first discovery, and `unknown` instead of guessing.
- Accept that some noisy rows may remain in the copy DB.
- At the end, produce confidence summaries and confidence distribution from the copy DB.

## State model
- `pending`
- `in_progress`
- `done`
- `unknown`
- `conflict`
- `failed`

Track at least:
- `company_id`
- `status`
- `attempt_count`
- `assigned_batch_id`
- `confidence`
- `error`

## progress.md requirements
- Keep these sections current:
  - Current phase
  - Counts by status
  - Last processed batches
  - Current blocker
  - Next action
  - Completed milestones
- Keep it short and operational.
- Add `CRM_ENRICHMENT_DONE` only when the job is truly complete.

## Completion rule
- Continue until no company in scope remains in a non-terminal state.
- Completion for the loop plugin is file-based: stop when `CRM_ENRICHMENT_DONE` exists in `progress.md`.
- After completion, summarize the copy DB with:
  - total enriched rows
  - counts by `confidence`
  - counts by `roles`
  - counts by `sectors`
  - high-confidence buyer candidates
