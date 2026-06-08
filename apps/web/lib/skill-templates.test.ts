import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SKILL_TEMPLATE_CATEGORIES,
  SKILL_TEMPLATE_IDS,
  SKILL_TEMPLATE_PERSONAS,
  SKILL_TEMPLATES,
  buildSkillTemplatePrompt,
  getSkillTemplate,
  isSkillTemplateId,
  type SkillTemplateId,
} from "./skill-templates";

describe("skill templates", () => {
  it("exposes the power-user template pack", () => {
    expect(SKILL_TEMPLATES.length).toBeGreaterThanOrEqual(30);
    expect(SKILL_TEMPLATES).toHaveLength(38);
    expect(SKILL_TEMPLATES.map((template) => template.id)).toEqual(
      SKILL_TEMPLATE_IDS,
    );
    expect(getSkillTemplate("icp-outreach-builder").title).toBe("ICP Outreach Builder");
    expect(getSkillTemplate("weekly-founder-digest").category).toBe("Run Founder Ops");
  });

  it("validates known template ids", () => {
    expect(isSkillTemplateId("icp-outreach-builder")).toBe(true);
    expect(isSkillTemplateId("pipeline-hygiene-digest")).toBe(true);
    expect(isSkillTemplateId("yc-outreach")).toBe(false);
    expect(isSkillTemplateId(null)).toBe(false);
  });

  it("throws when a known id is missing from the template registry", () => {
    const missingTemplateId = "missing-template" as SkillTemplateId;

    expect(() => getSkillTemplate(missingTemplateId)).toThrow(
      "Unknown skill template: missing-template",
    );
  });

  it("builds a reusable skill creation prompt", () => {
    const prompt = buildSkillTemplatePrompt("icp-outreach-builder");

    expect(prompt).toContain("ICP Outreach Builder");
    expect(prompt).toContain("one question at a time");
    expect(prompt).toContain("3-5 focused questions");
    expect(prompt).toContain("SKILL.md");
    expect(prompt).toContain("Do not create or edit any files until");
    expect(prompt).toContain("manual trigger and cron/scheduled agent messages");
    expect(prompt).toContain("send rules");
    expect(prompt).toContain("idempotency checks");
    expect(prompt).toContain("Required external setup");
  });

  it("marks every template with UI metadata", () => {
    const categories = new Set(SKILL_TEMPLATE_CATEGORIES);
    const personas = new Set(SKILL_TEMPLATE_PERSONAS);
    const ids = new Set<string>();

    for (const template of SKILL_TEMPLATES) {
      expect(ids.has(template.id)).toBe(false);
      ids.add(template.id);
      expect(categories.has(template.category)).toBe(true);
      expect(template.outcome).toBeTruthy();
      expect(template.summary).toBeTruthy();
      expect(template.autonomy).toBeTruthy();
      expect(template.personas.length).toBeGreaterThan(0);
      for (const persona of template.personas) {
        expect(personas.has(persona)).toBe(true);
      }
      for (const app of template.requiredApps) {
        expect(app.slug).not.toBe("apollo");
        expect(app.name).not.toBe("Apollo");
      }
      expect(template.triggerModes.length).toBeGreaterThan(0);
      expect(template.interviewTopics.length).toBeGreaterThan(3);
      expect(template.skillInstructions.length).toBeGreaterThan(3);
    }

    expect(ids.size).toBe(SKILL_TEMPLATES.length);
  });

  it("keeps each template definition in its own tiny file", () => {
    for (const template of SKILL_TEMPLATES) {
      const templateFile = fileURLToPath(
        new URL(`./skill-templates/${template.id}.ts`, import.meta.url),
      );

      expect(existsSync(templateFile)).toBe(true);
    }
  });
});
