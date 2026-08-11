import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ONBOARDING_STEPS,
  advanceOnboardingStep,
  isOnboardingComplete,
  readOnboardingState,
  readPersonalDomainsOverrides,
  writeOnboardingState,
  writePersonalDomainsOverrides,
  type OnboardingState,
} from "./denchclaw-state";

let tempHome: string;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "denchclaw-state-test-"));
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

describe("ONBOARDING_STEPS", () => {
  it("lists all canonical steps in order", () => {
    expect(ONBOARDING_STEPS).toEqual([
      "welcome",
      "identity",
      "dench-cloud",
      "skill-template",
      "complete",
    ]);
  });
});

describe("readOnboardingState", () => {
  it("returns a fresh `welcome` state when nothing is persisted yet", () => {
    const state = readOnboardingState();
    expect(state.currentStep).toBe("welcome");
    expect(state.completedSteps).toEqual([]);
    expect(state.identity).toBeUndefined();
    expect(state.startedAt).toBeTruthy();
  });

  it("round-trips through writeOnboardingState", () => {
    const initial = readOnboardingState();
    const next: OnboardingState = {
      ...initial,
      currentStep: "identity",
      completedSteps: ["welcome"],
      identity: { name: "Sarah", email: "sarah@acme.com", capturedAt: new Date().toISOString() },
      skillTemplate: {
        templateId: "icp-outreach-builder",
        selectedAt: "2026-04-15T00:00:00Z",
      },
    };
    writeOnboardingState(next);

    const loaded = readOnboardingState();
    expect(loaded.currentStep).toBe("identity");
    expect(loaded.completedSteps).toEqual(["welcome"]);
    expect(loaded.identity?.email).toBe("sarah@acme.com");
    expect(loaded.skillTemplate?.templateId).toBe("icp-outreach-builder");
  });
});

describe("advanceOnboardingStep", () => {
  it("marks the from-step complete and bumps to the to-step", () => {
    advanceOnboardingStep("welcome", "identity", {});
    const state = readOnboardingState();
    expect(state.currentStep).toBe("identity");
    expect(state.completedSteps).toContain("welcome");
  });

  it("merges patch into the state", () => {
    advanceOnboardingStep("welcome", "identity", {
      identity: { name: "Sarah", email: "sarah@acme.com", capturedAt: "2026-04-15T00:00:00Z" },
    });
    const state = readOnboardingState();
    expect(state.identity?.name).toBe("Sarah");
  });

  it("dedupes already-completed steps", () => {
    advanceOnboardingStep("welcome", "identity", {});
    advanceOnboardingStep("welcome", "identity", {}); // re-run shouldn't grow array
    const state = readOnboardingState();
    expect(state.completedSteps.filter((s) => s === "welcome")).toHaveLength(1);
  });

  it("advances to `complete` and isOnboardingComplete returns true", () => {
    advanceOnboardingStep("welcome", "complete", {});
    expect(isOnboardingComplete()).toBe(true);
  });
});

describe("personal-domains overrides", () => {
  it("normalizes adds and removes to lowercase deduped lists", () => {
    writePersonalDomainsOverrides({
      add: ["Custom-Personal.IO", "another.test", "another.test"],
      remove: ["GMAIL.com"],
    });
    const out = readPersonalDomainsOverrides();
    expect(out.add).toEqual(expect.arrayContaining(["custom-personal.io", "another.test"]));
    expect(out.add).toHaveLength(2);
    expect(out.remove).toEqual(["gmail.com"]);
  });
});

describe("atomic writes", () => {
  it("writes a valid JSON file (no half-written content)", () => {
    advanceOnboardingStep("welcome", "identity", {
      identity: { name: "Sarah", email: "sarah@acme.com", capturedAt: "2026-04-15T00:00:00Z" },
    });
    const onboardingPath = join(tempHome, ".openclaw-dench", "workspace", ".denchclaw", "onboarding.json");
    const raw = readFileSync(onboardingPath, "utf-8");
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(raw.endsWith("\n")).toBe(true);
  });
});
