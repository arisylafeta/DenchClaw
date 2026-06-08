import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readOnboardingState, type OnboardingState } from "@/lib/denchclaw-state";

vi.mock("@/lib/telemetry", () => ({
  trackServer: vi.fn(),
}));

const { PUT } = await import("./route");

let tempHome: string;

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/onboarding/state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("onboarding state API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tempHome = mkdtempSync(join(tmpdir(), "onboarding-state-route-test-"));
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

  it("persists a valid skill template choice", async () => {
    const res = await PUT(makeRequest({
      from: "skill-template",
      to: "complete",
      skillTemplate: { templateId: "icp-outreach-builder" },
    }));

    expect(res.status).toBe(200);
    const json = (await res.json()) as OnboardingState;
    expect(json.currentStep).toBe("complete");
    expect(json.completedSteps).toContain("skill-template");
    expect(json.skillTemplate?.templateId).toBe("icp-outreach-builder");
    expect(json.skillTemplate?.selectedAt).toBeTruthy();
    expect(readOnboardingState().skillTemplate?.templateId).toBe("icp-outreach-builder");
  });

  it("rejects unknown skill template ids", async () => {
    const res = await PUT(makeRequest({
      from: "skill-template",
      to: "complete",
      skillTemplate: { templateId: "yc-outreach" },
    }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Unknown skill template." });
    expect(readOnboardingState().currentStep).toBe("welcome");
  });

  it("rejects skill template patches from other steps", async () => {
    const res = await PUT(makeRequest({
      from: "backfill",
      to: "skill-template",
      skillTemplate: { templateId: "icp-outreach-builder" },
    }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Skill template choices can only be saved from the skill-template step.",
    });
    expect(readOnboardingState().currentStep).toBe("welcome");
  });
});
