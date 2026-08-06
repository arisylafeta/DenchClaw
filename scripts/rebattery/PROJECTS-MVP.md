# ReBattery Projects / Work Tasks MVP (prototype)

This is a deliberately small, non-production fixture. Run it only against a scratch Postgres database:

```bash
PROJECTS_MVP_DATABASE_URL=postgres://... pnpm projects:mvp
```

The command applies the canonical schema, registers `project` and `work_task` metadata, and loads exactly one project and eight tasks. It refuses to use the normal `DATABASE_URL` or local production defaults. Tasks use the existing Kanban interface with `Status`; the `Project` relation is resolved to `projects.name`.

Project/task learnings and decisions use the existing linked Markdown entry behavior (`/api/workspace/objects/{name}/entries/{id}/content`). Edit the generated/registered Markdown document through the existing detail UI or file API. This prototype intentionally does not add `PROJECT.yaml`, `TASK.yaml`, watchers, imports, sync, saved views, or Linear calls. `source_path` and `external_linear_id` preserve provenance only.
