import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  advanceOnboardingStep,
  readOnboardingState,
  writeOnboardingState,
  type OnboardingState,
} from "@/lib/denchclaw-state";
import { buildSkillTemplatePrompt } from "@/lib/skill-templates";

const { POST } = await import("./route");

let tempHome: string;

describe("skill template consume API", () => {
  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "skill-template-consume-test-"));
    process.env.OPENCLAW_HOME = tempHome;
  });

  afterEach(() => {
    delete process.env.OPENCLAW_HOME;
    try {
      rmSync(tempHome, { recursive: true, force: true });
    } catch {
      // ignore cleanup races
    }
  });

  it("returns the selected template prompt once and marks it consumed", async () => {
    advanceOnboardingStep("skill-template", "complete", {
      skillTemplate: {
        templateId: "icp-outreach-builder",
        selectedAt: "2026-04-15T00:00:00.000Z",
      },
    });

    const first = await POST();
    expect(first.status).toBe(200);
    const firstJson = (await first.json()) as { prompt: string | null; templateId?: string };
    expect(firstJson.templateId).toBe("icp-outreach-builder");
    expect(firstJson.prompt).toBe(buildSkillTemplatePrompt("icp-outreach-builder"));
    expect(readOnboardingState().skillTemplate?.promptConsumedAt).toBeTruthy();

    const second = await POST();
    expect(await second.json()).toEqual({ prompt: null });
  });

  it("does not consume before onboarding is complete", async () => {
    writeOnboardingState({
      ...readOnboardingState(),
      currentStep: "skill-template",
      skillTemplate: {
        templateId: "icp-outreach-builder",
        selectedAt: "2026-04-15T00:00:00.000Z",
      },
    });

    const res = await POST();

    expect(await res.json()).toEqual({ prompt: null });
    expect(readOnboardingState().skillTemplate?.promptConsumedAt).toBeUndefined();
  });

  it("ignores invalid persisted template ids", async () => {
    const state: OnboardingState = {
      ...readOnboardingState(),
      currentStep: "complete",
      skillTemplate: {
        templateId: "unknown-template",
        selectedAt: "2026-04-15T00:00:00.000Z",
      },
    };
    writeOnboardingState(state);

    const res = await POST();

    expect(await res.json()).toEqual({ prompt: null });
    expect(readOnboardingState().skillTemplate?.promptConsumedAt).toBeUndefined();
  });
});
