import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { deriveProfile, mergeDerivedProfile, parseDossier, validateDossier } from "./buyer-dossier";

// The same fixtures drive scripts/rebattery/test_buyer_dossier.py, so the TypeScript and Python
// implementations cannot drift silently. Synthetic companies only: no real company data in git.
const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/rebattery/fixtures/buyer_dossier");

type Fixture = {
  frontmatter: Record<string, unknown>;
  body: string;
  errors: string[];
  profile: Record<string, unknown> | null;
};

function fixtures(): [string, Fixture][] {
  return fs
    .readdirSync(FIXTURES)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => [
      name.replace(/\.md$/, ""),
      JSON.parse(fs.readFileSync(path.join(FIXTURES, name.replace(/\.md$/, ".json")), "utf8")) as Fixture,
    ]);
}

describe("buyer dossier parity with scripts/rebattery/buyer_dossier.py", () => {
  it("finds the shared fixtures", () => {
    expect(fixtures().map(([name]) => name)).toEqual(["full", "invalid", "minimal", "no-frontmatter"]);
  });

  for (const [name, fixture] of fixtures()) {
    describe(name, () => {
      const text = fs.readFileSync(path.join(FIXTURES, `${name}.md`), "utf8");

      it("parses the same frontmatter and body", () => {
        const parsed = parseDossier(text);
        expect(parsed.frontmatter).toEqual(fixture.frontmatter);
        expect(parsed.body).toEqual(fixture.body);
      });

      it("reports the same validation errors", () => {
        expect(validateDossier(parseDossier(text).frontmatter)).toEqual(fixture.errors);
      });

      if (fixture.profile) {
        it("derives the same buyer_profile", () => {
          expect(deriveProfile(parseDossier(text).frontmatter)).toEqual(fixture.profile);
        });
      }
    });
  }
});

describe("derive as a merge", () => {
  const full = fixtures().find(([name]) => name === "full")?.[1];
  if (!full?.profile) throw new Error("full fixture missing");

  it("overwrites derived keys and passes every other key through", () => {
    const existing = {
      chemistries: ["NMC"],
      wants: "old wants",
      min_soh: 80,
      origins: ["FR"],
      evidence_url: "https://example.test/evidence",
      criteria_evidence: [{ source_kind: "survey", source_id: "old:1" }],
    };
    const merged = mergeDerivedProfile(existing, full.frontmatter);
    const derived = Object.fromEntries(merged.derived.map((key) => [key, merged.profile[key]]));
    expect(derived).toEqual(full.profile);
    expect(merged.profile.chemistries).toEqual(["LFP", "NMC"]);
    expect(merged.passedThrough.sort()).toEqual(["criteria_evidence", "evidence_url"]);
    expect(merged.derived).toContain("dossier");
    expect(merged.derived).not.toContain("evidence_url");
  });

  it("drops a derived key the dossier no longer states instead of keeping it stale", () => {
    const minimal = fixtures().find(([name]) => name === "minimal")?.[1];
    const merged = mergeDerivedProfile({ origins: ["FR"], min_soh: 80, evidence_url: "https://example.test" }, minimal?.frontmatter);
    expect(merged.profile).not.toHaveProperty("origins");
    expect(merged.profile).not.toHaveProperty("min_soh");
    expect(merged.profile.evidence_url).toBe("https://example.test");
  });

  it("treats a dossier with no frontmatter as an empty buy box", () => {
    const merged = mergeDerivedProfile({ evidence_url: "https://example.test" }, parseDossier("# nothing").frontmatter);
    expect(merged.profile).toEqual({
      evidence_url: "https://example.test",
      chemistries: [],
      formats: [],
      makes: [],
      cell_makers: [],
      part_numbers: [],
      kwh_min: null,
      kwh_max: null,
      wants: "",
      dossier: {},
    });
  });
});
