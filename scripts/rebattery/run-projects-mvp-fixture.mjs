// Defaults to scratch-only. Production requires an explicit, approval-gated override.
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const url = process.env.PROJECTS_MVP_DATABASE_URL;
if (!url)
  throw new Error(
    "Set PROJECTS_MVP_DATABASE_URL to a scratch/test Postgres URL; refusing production defaults.",
  );
const databaseName = new URL(url).pathname.replace(/^\//, "");
const productionApproved = process.env.PROJECTS_MVP_ALLOW_PRODUCTION === "approved-after-backup";
if (!databaseName || (databaseName === "denchclaw" && !productionApproved)) {
  throw new Error(
    "PROJECTS_MVP_DATABASE_URL must name a scratch database unless production is explicitly approved after backup.",
  );
}

const workspaceRootInput = process.env.PROJECTS_MVP_WORKSPACE_ROOT;
if (!workspaceRootInput) {
  throw new Error("Set PROJECTS_MVP_WORKSPACE_ROOT to the isolated scratch workspace.");
}
const requestedWorkspaceRoot = resolve(workspaceRootInput);
if (!existsSync(requestedWorkspaceRoot) || lstatSync(requestedWorkspaceRoot).isSymbolicLink()) {
  throw new Error("PROJECTS_MVP_WORKSPACE_ROOT must be an existing real directory, not a symlink.");
}
const workspaceRoot = realpathSync(requestedWorkspaceRoot);
const productionWorkspacePath = resolve(process.env.HOME ?? "/root", ".hermes/workspace");
const productionWorkspace = existsSync(productionWorkspacePath)
  ? realpathSync(productionWorkspacePath)
  : productionWorkspacePath;
const productionRuntimePath = resolve("/root/denchclaw");
const productionRuntime = existsSync(productionRuntimePath)
  ? realpathSync(productionRuntimePath)
  : productionRuntimePath;
if (
  (workspaceRoot === productionWorkspace || workspaceRoot === productionRuntime) &&
  !productionApproved
) {
  throw new Error("PROJECTS_MVP_WORKSPACE_ROOT must be isolated unless production is explicitly approved after backup.");
}

const schema = fileURLToPath(
  new URL("../../apps/web/lib/crm-postgres/schema.sql", import.meta.url),
);
const fixture = fileURLToPath(new URL("./projects-mvp-fixture.sql", import.meta.url));
const manifestPath = fileURLToPath(new URL("./projects-mvp-manifest.json", import.meta.url));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (manifest.projects.length !== 13 || manifest.tasks.length !== 72) {
  throw new Error(`manifest cardinality failed: ${manifest.projects.length} projects, ${manifest.tasks.length} tasks`);
}
if (!manifest.missing_canonical_ids.includes("REB-83")) {
  throw new Error("manifest must explicitly preserve missing canonical REB-83");
}
const reb73 = manifest.tasks.find((task) => task.reb_key === "REB-73");
if (reb73?.external_linear_id !== "REB-83") {
  throw new Error("manifest must preserve REB-73 canonical ID / external Linear REB-83 collision");
}
const taskKeys = new Set(manifest.tasks.map((task) => task.reb_key));
if (taskKeys.size !== manifest.tasks.length) throw new Error("manifest contains duplicate REB keys");

const objectDir = join(workspaceRoot, "work_task");
mkdirSync(objectDir, { recursive: true });
if (lstatSync(objectDir).isSymbolicLink() || realpathSync(objectDir) !== objectDir) {
  throw new Error("scratch work_task directory must not be a symlink");
}

function writeScratchWorkspaceFile(relativePath, content) {
  const target = resolve(workspaceRoot, relativePath);
  if (!target.startsWith(`${workspaceRoot}${sep}`)) {
    throw new Error(`workspace path escapes scratch root: ${relativePath}`);
  }
  if (realpathSync(dirname(target)) !== objectDir) {
    throw new Error(`workspace document parent is not the scratch work_task directory: ${relativePath}`);
  }
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
    throw new Error(`refusing symlinked workspace file: ${relativePath}`);
  }
  const fd = openSync(
    target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, content);
  } finally {
    closeSync(fd);
  }
}

writeScratchWorkspaceFile("work_task/.object.yaml", [
  "id: reb_work_task_object",
  "name: work_task",
  "description: Work tasks related to ReBattery projects",
  "icon: list-checks",
  "default_view: kanban",
  `entry_count: ${manifest.tasks.length}`,
  "view_settings:",
  "  kanbanField: Status",
  "fields: []",
  "",
].join("\n"));

for (const task of manifest.tasks) {
  const source = readFileSync(task.source_path, "utf8");
  const digest = createHash("sha256").update(source).digest("hex");
  if (digest !== task.source_sha256) {
    throw new Error(`source changed for ${task.reb_key}: expected ${task.source_sha256}, got ${digest}`);
  }
  const match = source.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  if (!match) throw new Error(`invalid Markdown frontmatter for ${task.reb_key}`);
  writeScratchWorkspaceFile(task.document.file_path, match[1]);
}

for (const file of [schema, fixture]) {
  const result = spawnSync("psql", [url, "-X", "-v", "ON_ERROR_STOP=1", "-f", file], {
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`psql failed for ${file} with status ${result.status}`);
}
const check = spawnSync(
  "psql",
  [
    url,
    "-X",
    "-A",
    "-t",
    "-F",
    ",",
    "-c",
    `select
       (select count(*) from projects where id like 'reb-project-%'),
       (select count(*) from work_tasks where reb_key ~ '^REB-([5-9][0-9]|1[01][0-9]|12[0-2])$'),
       (select count(*) from crm_documents d join work_tasks t on t.id = d.entry_id
         where d.parent_object_id = 'reb_work_task_object' and d.id like 'reb-work-task-document-%'),
       (select count(distinct d.entry_id) from crm_documents d join work_tasks t on t.id = d.entry_id
         where d.parent_object_id = 'reb_work_task_object' and d.id like 'reb-work-task-document-%'),
       (select count(distinct d.file_path) from crm_documents d join work_tasks t on t.id = d.entry_id
         where d.parent_object_id = 'reb_work_task_object' and d.id like 'reb-work-task-document-%')`,
  ],
  { encoding: "utf8" },
);
if (check.error) throw check.error;
if (check.status !== 0)
  throw new Error(check.stderr || `cardinality query failed with status ${check.status}`);
if (check.stdout.trim() !== "13,72,72,72,72")
  throw new Error(`fixture cardinality failed: ${check.stdout.trim()}`);
console.log(
  "PROJECTS MVP PROTOTYPE OK: 13 hidden projects, 72 tasks, 72 linked Markdown bodies",
);
