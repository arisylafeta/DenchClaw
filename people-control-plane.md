# CRM People Enrichment Control Plane

## Purpose
- `people-scope.json` is the immutable input snapshot.
- `people-enrichment-state.json` is the only mutable checkpoint.
- `people-progress.md` is the human-readable runtime summary and completion marker.
- `people-worker-prompt.md` defines the worker contract.
- `people-batch-inputs/` preserves assigned batch inputs.
- The copy database `denchclaw_people_copy` is the main enrichment output surface.

## Ownership
- Only the orchestrator mutates `people-enrichment-state.json`.
- Workers never edit the queue.
- Workers write directly to `public.crm_people_enrichments` in `denchclaw_people_copy`.

## Sourcing rule
- Workers should use **SearXNG as the ONLY enrichment source** (Apollo MCP is NOT available).
- Build search queries using available context: full name, company name/domain, email domain.
- Prefer LinkedIn profiles and company team pages found through SearXNG.
- Limit to 3 queries per person to avoid rate limits.

## Retry model
- First pass: SearXNG discovery
- Insufficient evidence: mark as `unknown`
- Conflicts are only for duplicate assignment or identity collisions.

## Loop plugin fit
- The `/loop` plugin is a scheduler, not an orchestrator.
- Use `people-orchestrator-prompt.md` as the stable prompt file.
- Use `people-progress.md` as the runtime progress file and stop marker surface.
- Do not include large JSON state files through `--include-file`; have the orchestrator read them directly.
