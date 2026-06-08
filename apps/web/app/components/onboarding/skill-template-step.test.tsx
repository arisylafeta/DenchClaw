// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OnboardingState } from "@/lib/denchclaw-state";
import { SkillTemplateStep } from "./skill-template-step";

const baseState: OnboardingState = {
  version: 1,
  currentStep: "skill-template",
  completedSteps: [
    "welcome",
    "identity",
    "dench-cloud",
    "connect-gmail",
    "connect-calendar",
    "backfill",
  ],
  startedAt: "2026-04-29T18:45:14.580Z",
  updatedAt: "2026-04-29T18:45:15.517Z",
};

describe("SkillTemplateStep", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("marks the persisted template as selected in the shared gallery", () => {
    render(
      <SkillTemplateStep
        state={{
          ...baseState,
          skillTemplate: {
            templateId: "crm-contact-enricher",
            selectedAt: "2026-04-30T00:00:00.000Z",
          },
        }}
        onAdvance={() => {}}
      />,
    );

    expect(
      screen.getByRole("article", { name: /CRM Contact Enricher/i }),
    ).toHaveAttribute("data-selected", "true");
  });

  it("saves the selected template through the existing onboarding state contract", async () => {
    const user = userEvent.setup();
    const onAdvance = vi.fn();
    const bodies: unknown[] = [];
    const nextState: OnboardingState = {
      ...baseState,
      currentStep: "complete",
      completedSteps: [...baseState.completedSteps, "skill-template"],
      skillTemplate: {
        templateId: "company-deep-researcher",
        selectedAt: "2026-04-30T00:00:00.000Z",
      },
    };

    global.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof init?.body !== "string") {
        throw new Error("Expected string JSON body.");
      }
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify(nextState));
    }) as typeof fetch;

    render(<SkillTemplateStep state={baseState} onAdvance={onAdvance} />);

    await user.click(
      screen.getByRole("button", { name: /Choose Company Deep Researcher/i }),
    );
    await user.click(screen.getByRole("button", { name: "Start with this" }));

    await waitFor(() => {
      expect(onAdvance).toHaveBeenCalledWith(nextState);
    });
    expect(bodies).toEqual([
      {
        from: "skill-template",
        to: "complete",
        skillTemplate: { templateId: "company-deep-researcher" },
      },
    ]);
  });
});
