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
    expect(SKILL_TEMPLATES).toHaveLength(44);
    expect(SKILL_TEMPLATES.map((template) => template.id)).toEqual(
      SKILL_TEMPLATE_IDS,
    );
    expect(getSkillTemplate("icp-outreach-builder").title).toBe("ICP Outreach Builder");
    expect(getSkillTemplate("weekly-founder-digest").category).toBe("Run Founder Ops");
  });

  it("validates known template ids", () => {
    expect(isSkillTemplateId("icp-outreach-builder")).toBe(true);
    expect(isSkillTemplateId("pipeline-hygiene-digest")).toBe(true);
    expect(isSkillTemplateId("deck-claim-verifier")).toBe(true);
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
    expect(prompt).toContain("explicit send rules");
    expect(prompt).toContain("Which buyer personas should DenchClaw");
    expect(prompt).toContain("Who this skill is for");
    expect(prompt).toContain("idempotency checks");
    expect(prompt).toContain("Suggested app connections");
    expect(prompt).toContain("[Connect Gmail](dench://composio/connect?toolkit=gmail&name=Gmail)");
    expect(prompt).toContain("[Connect HubSpot](dench://composio/connect?toolkit=hubspot&name=HubSpot)");
    expect(prompt).toContain("[Connect LinkedIn](dench://composio/connect?toolkit=linkedin&name=LinkedIn)");
    expect(prompt).toContain("not required to start the interview");
    expect(prompt).toContain("concrete activity logger policy");
    expect(prompt).toContain("Use this tailored logger contract");
    expect(prompt).toContain("Write campaign activity entries");
    expect(prompt).toContain("draft IDs created");
    expect(prompt).toContain("timestamped activity log entries");
  });

  it("marks every template with hand-authored UI and prompt metadata", () => {
    const categories = new Set(SKILL_TEMPLATE_CATEGORIES);
    const personas = new Set(SKILL_TEMPLATE_PERSONAS);
    const ids = new Set<string>();
    const instructionFingerprints = new Set<string>();

    for (const template of SKILL_TEMPLATES) {
      expect(ids.has(template.id)).toBe(false);
      ids.add(template.id);
      expect(categories.has(template.category)).toBe(true);
      expect(template.outcome).toBeTruthy();
      expect(template.summary).toBeTruthy();
      expect(template.userUseCase).toBeTruthy();
      expect(template.userUseCase.length).toBeGreaterThan(80);
      expect(template.autonomy).toBeTruthy();
      expect(template.personas.length).toBeGreaterThan(0);
      for (const persona of template.personas) {
        expect(personas.has(persona)).toBe(true);
      }
      for (const app of template.requiredApps) {
        expect(app.slug).not.toBe("apollo");
        expect(app.name).not.toBe("Apollo");
      }
      expect(template.suggestedApps.length).toBeGreaterThan(0);
      for (const app of template.suggestedApps) {
        expect(app.slug).not.toBe("apollo");
        expect(app.name).not.toBe("Apollo");
      }
      for (const requiredApp of template.requiredApps) {
        expect(template.suggestedApps.map((app) => app.slug)).toContain(requiredApp.slug);
      }
      expect(template.triggerModes.length).toBeGreaterThan(0);
      expect(template.interviewQuestions.length).toBeGreaterThanOrEqual(4);
      expect(template.interviewQuestions.length).toBeLessThanOrEqual(5);
      for (const question of template.interviewQuestions) {
        expect(question.id).toMatch(/^[a-z0-9-]+$/);
        expect(question.prompt.length).toBeGreaterThan(24);
        expect(typeof question.required).toBe("boolean");
        if (question.options) {
          expect(question.options.length).toBeGreaterThan(1);
          for (const option of question.options) {
            expect(option.id).toMatch(/^[a-z0-9-]+$/);
            expect(option.label).toBeTruthy();
          }
        }
      }
      expect(template.skillInstructions.length).toBeGreaterThanOrEqual(6);
      expect(template.activityLogInstructions.length).toBeGreaterThanOrEqual(6);
      const activityLogText = template.activityLogInstructions.join("\n");
      expect(activityLogText).toMatch(
        /\b(record|records|artifact|document|note|digest|summary|history|table|queue)\b/i,
      );
      expect(activityLogText).toMatch(
        /\b(source|evidence|confidence|owner|approval|skipped|suppressed|next action|fields|draft|task)\b/i,
      );
      expect(activityLogText).toMatch(/\b(scheduled|rerun|refresh|cron|prior run|previous)\b/i);
      expect(activityLogText).not.toMatch(/\blog activity\b/i);
      expect(activityLogText).not.toMatch(/\blog everything\b/i);
      expect(activityLogText).not.toMatch(/\bactivity log goes here\b/i);
      expect(activityLogText).not.toMatch(/\btbd\b/i);
      const allTemplateText = [
        template.userUseCase,
        ...template.interviewQuestions.map((question) => question.prompt),
        ...template.skillInstructions,
        ...template.activityLogInstructions,
      ].join("\n");
      expect(allTemplateText).not.toContain("The exact ");
      expect(allTemplateText).not.toContain("for this workflow");
      expect(allTemplateText).not.toContain("A clear trigger description");
      expect(allTemplateText).not.toContain("Step-by-step instructions to achieve this outcome");
      const fingerprint = template.skillInstructions.join("|");
      expect(instructionFingerprints.has(fingerprint)).toBe(false);
      instructionFingerprints.add(fingerprint);
    }

    expect(ids.size).toBe(SKILL_TEMPLATES.length);
  });

  it("keeps each template definition in its own file", () => {
    for (const template of SKILL_TEMPLATES) {
      const templateFile = fileURLToPath(
        new URL(`./skill-templates/${template.id}.ts`, import.meta.url),
      );

      expect(existsSync(templateFile)).toBe(true);
    }
  });
});
