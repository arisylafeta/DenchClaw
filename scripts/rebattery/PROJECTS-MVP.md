# ReBattery Projects / Work Tasks MVP (prototype)

This is a deliberately small, non-production fixture. Run it only against a scratch Postgres database:

```bash
PROJECTS_MVP_DATABASE_URL=postgres://... pnpm projects:mvp
```

The command applies the canonical schema, registers `project` as hidden reference data and `work_task` as the only sidebar object, then loads exactly one project and eight tasks. It refuses to use the normal `DATABASE_URL` or local production defaults. Work Tasks use the existing Kanban interface grouped by `Status` (`Planned`, `In Progress`, `Done`, `Retired`). The existing Filter control filters the board by the `Project` relation, resolved to `projects.name`.

Project/task learnings and decisions use the existing linked Markdown entry behavior (`/api/workspace/objects/{name}/entries/{id}/content`). Edit the generated/registered Markdown document through the existing detail UI or file API. This prototype intentionally does not add `PROJECT.yaml`, `TASK.yaml`, watchers, imports, sync, saved views, or Linear calls. `source_path` and `external_linear_id` preserve provenance only.
