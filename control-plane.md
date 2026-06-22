# CRM Enrichment Control Plane

## Purpose
- `company-scope.json` is the immutable input snapshot.
- `enrichment-state.json` is the only mutable checkpoint.
- `progress.md` is the human-readable runtime summary and completion marker.
- `worker-prompt.md` defines the worker contract.
- `batch-inputs/` preserves assigned batch inputs.
- The copy database `denchclaw_enrichment_copy` is the main enrichment output surface.

## Ownership
- Only the orchestrator mutates `enrichment-state.json`.
- Workers never edit the queue.
- Workers write directly to `public.crm_company_enrichments` in `denchclaw_enrichment_copy`.

## Sourcing rule
- Workers should use SearXNG as the default open-web discovery path.
- Prefer official company pages found through SearXNG.
- Fall back to other credible sources only when the official site is unavailable or insufficient.

## Retry model
- First pass: enricher
- Insufficient evidence: unknown
- Conflicts are only for duplicate assignment or identity collisions.

## Loop plugin fit
- The new `/loop` plugin is a scheduler, not an orchestrator.
- Use `orchestrator-prompt.md` as the stable prompt file.
- Use `progress.md` as the runtime progress file and stop marker surface.
- Do not include large JSON state files through `--include-file`; have the orchestrator read them directly.
