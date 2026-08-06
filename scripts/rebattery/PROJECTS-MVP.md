# ReBattery Work Tasks MVP migration (prototype)

This is a non-production migration fixture. Run it only against an isolated Postgres database and workspace:

```bash
PROJECTS_MVP_DATABASE_URL=postgres://... \
PROJECTS_MVP_WORKSPACE_ROOT=/path/to/isolated/workspace \
pnpm projects:mvp
```

The command refuses the production `denchclaw` database and canonical Hermes workspace by default. After explicit deployment approval and a verified backup, production additionally requires `PROJECTS_MVP_ALLOW_PRODUCTION=approved-after-backup`. It applies the schema, registers `project` as hidden reference data and `work_task` as the only sidebar object, then loads the canonical portfolio:

- 13 hidden projects
- 72 canonical Work Tasks from REB-50 through REB-122
- explicit preservation of the missing canonical REB-83
- explicit preservation of REB-73's external Linear ID REB-83
- statuses mapped as `Planned`, `In Progress`, `Done`, and `Retired`
- one linked Markdown body per Work Task

`scripts/rebattery/projects-mvp-manifest.json` is the deterministic migration manifest. It records the source path and SHA-256 for each native Work Task. The runner verifies those hashes, strips YAML frontmatter, stages the readable body inside the isolated workspace, and registers it through `crm_documents`. It fails if project, task, or document cardinality differs from 13/72/72.

The Work Tasks page renders a full-width, independently expandable Kanban accordion per visible project. The existing Project filter narrows those accordions. Project remains a durable relation/taxonomy, not a standalone sidebar page. REB-82 remains the shared First-party media delivery capability and intentionally has no owning project.

This prototype intentionally does not add `PROJECT.yaml`, `TASK.yaml`, watchers, bidirectional sync, or Linear calls. `source_path`, source hashes, and `external_linear_id` preserve provenance.
