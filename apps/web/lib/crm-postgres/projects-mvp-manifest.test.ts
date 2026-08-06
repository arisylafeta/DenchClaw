import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(
  readFileSync(new URL("../../../../scripts/rebattery/projects-mvp-manifest.json", import.meta.url), "utf8"),
) as {
  missing_canonical_ids: string[];
  projects: Array<{ id: string }>;
  tasks: Array<{
    id: string;
    reb_key: string;
    status: string;
    project_id: string | null;
    external_linear_id: string;
    source_sha256: string;
    document: { id: string; file_path: string };
  }>;
};

describe("full Work Task migration manifest", () => {
  it("contains the complete canonical portfolio without duplicate IDs", () => {
    expect(manifest.projects).toHaveLength(13);
    expect(manifest.tasks).toHaveLength(72);
    expect(new Set(manifest.projects.map((project) => project.id)).size).toBe(13);
    expect(new Set(manifest.tasks.map((task) => task.id)).size).toBe(72);
    expect(new Set(manifest.tasks.map((task) => task.reb_key)).size).toBe(72);
    expect(manifest.missing_canonical_ids).toEqual(["REB-83"]);
  });

  it("preserves statuses, shared media ownership, documents, and REB-73 provenance", () => {
    expect(Array.from(new Set(manifest.tasks.map((task) => task.status))).sort()).toEqual(
      ["Done", "In Progress", "Planned", "Retired"].sort(),
    );
    expect(manifest.tasks.filter((task) => task.project_id === null).map((task) => task.reb_key)).toEqual(["REB-82"]);
    expect(manifest.tasks.find((task) => task.reb_key === "REB-73")?.external_linear_id).toBe("REB-83");
    expect(manifest.tasks.every((task) => /^[a-f0-9]{64}$/.test(task.source_sha256))).toBe(true);
    expect(new Set(manifest.tasks.map((task) => task.document.file_path)).size).toBe(72);
  });
});
