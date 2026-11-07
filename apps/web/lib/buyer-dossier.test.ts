import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TEST_REGISTRY } from "./bulk-registry.fixture";
import { ORIGINS, deriveProfile, mergeDerivedProfile, parseDossier, stableStringify, validateDossier } from "./buyer-dossier";

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
    .filter((name) => name.endsWith(".md") && name !== "README.md")
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

type MergeCase = {
  name: string;
  existing: Record<string, unknown>;
  frontmatter: Record<string, unknown>;
  expected_passed_through: string[];
  expected_profile: Record<string, unknown>;
  changed: boolean;
};

// scripts/rebattery/fixtures/buyer_dossier/merge.json drives the Python merge too, and `changed` is
// the same comparison saveDossier writes buyer_profile on.
const MERGE_CASES: MergeCase[] = (
  JSON.parse(fs.readFileSync(path.join(FIXTURES, "merge.json"), "utf8")) as { cases: MergeCase[] }
).cases;

describe("merge parity with scripts/rebattery/buyer_dossier.py", () => {
  it("finds the shared merge fixtures", () => {
    expect(MERGE_CASES.map((item) => item.name)).toEqual([
      "pass-through keys survive and derived keys are replaced",
      "the same dossier over its own derived profile changes nothing",
      "a derived key the dossier no longer states is dropped, not kept stale",
      "the kwh range comes from the asks, not an older smaller purchase",
      "with no capacity in the asks the range falls back to what they bought",
      "origins is the application origin and source countries stay in the dossier",
    ]);
  });

  for (const item of MERGE_CASES) {
    it(`merges and detects change: ${item.name}`, () => {
      const merged = mergeDerivedProfile(item.existing, item.frontmatter);
      // The fixture lists the pass-through keys alphabetically (Python's order); only the set matters.
      expect([...merged.passedThrough].toSorted()).toEqual(item.expected_passed_through);
      expect(merged.profile).toEqual(item.expected_profile);
      const changed = stableStringify(item.existing) !== stableStringify(merged.profile);
      expect(changed).toBe(item.changed);
    });
  }
});

describe("derive", () => {
  it("derives the range from the asks even when an older purchase is smaller", () => {
    const frontmatter = parseDossier(`---
company_id: connected-energy-like
products:
  - format: packs
    chemistry: LFP
    kwh: [30]
    status: asked
  - make: Renault
    format: packs
    chemistry: LMO
    kwh: [22]
    status: bought
---
`).frontmatter;
    const profile = deriveProfile(frontmatter);
    expect([profile.kwh_min, profile.kwh_max]).toEqual([30, 30]);
  });

  it("keeps source countries out of the flat profile", () => {
    const profile = deriveProfile(parseDossier(
      "---\ncompany_id: x\norigins: ['bus or truck', 'Passenger EV']\nsource_countries: [FR, DE]\n---\n",
    ).frontmatter);
    expect(profile.origins).toEqual(["Passenger EV", "Bus or truck"]);
    expect(profile).not.toHaveProperty("source_countries");
  });
});

describe("dossier validation", () => {
  it("keeps the origin vocabulary identical to the attribute registry", () => {
    // `origins` in the buy box is the battery's application origin, seeded by migration 064.
    expect(ORIGINS).toEqual(TEST_REGISTRY.specLists.origins);
  });

  it("rejects a country in origins and an ISO-2 code that is not a country", () => {
    const errors = validateDossier(
      parseDossier("---\ncompany_id: x\norigins: [DE, 'Passenger EV']\nsource_countries: [DEU, de]\n---\n").frontmatter,
    );
    expect(errors.some((error) => error.startsWith("origins[0]:"))).toBe(true);
    expect(errors.some((error) => error.startsWith("source_countries[0]:"))).toBe(true);
    expect(errors.some((error) => error.startsWith("source_countries[1]:"))).toBe(false);
  });

  it("requires company_id and keeps it text", () => {
    expect(validateDossier(parseDossier("---\ncompany: no id\n---\n").frontmatter)).toContain(
      "company_id: required (the company the dossier belongs to)",
    );
    expect(validateDossier(parseDossier("---\ncompany_id: '  '\n---\n").frontmatter)).toContain(
      "company_id: required (the company the dossier belongs to)",
    );
    expect(validateDossier(parseDossier("---\ncompany_id: [a, b]\n---\n").frontmatter)).toContain(
      "company_id: must be a string",
    );
  });
});
