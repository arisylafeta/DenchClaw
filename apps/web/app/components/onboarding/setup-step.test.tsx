// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OnboardingState } from "@/lib/denchclaw-state";
import { SetupStep } from "./setup-step";

const state: OnboardingState = {
  version: 1,
  currentStep: "dench-cloud",
  completedSteps: ["welcome", "identity"],
  startedAt: "2026-04-29T18:45:14.580Z",
  updatedAt: "2026-04-29T18:45:15.517Z",
};

describe("SetupStep", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("shows only the ReBattery Cloud setup", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({
      configured: false,
      source: null,
      primaryModel: null,
    }))) as typeof fetch;

    render(<SetupStep state={state} onAdvance={() => {}} onStageChange={() => {}} />);

    expect(await screen.findByText("ReBattery Cloud")).toBeInTheDocument();
    expect(screen.queryByText("Gmail")).not.toBeInTheDocument();
    expect(screen.queryByText("Google Calendar")).not.toBeInTheDocument();
  });

  it("records configured cloud setup and advances directly to templates", async () => {
    const onAdvance = vi.fn();
    const nextState = { ...state, currentStep: "skill-template" as const };
    let calls = 0;
    global.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) {return new Response(JSON.stringify({ configured: true, source: "cli", primaryModel: "dench-cloud/model" }));}
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init?.body as string)).toEqual({ acceptCli: true });
      return new Response(JSON.stringify(nextState));
    }) as typeof fetch;

    render(<SetupStep state={state} onAdvance={onAdvance} onStageChange={() => {}} />);

    await waitFor(() => expect(onAdvance).toHaveBeenCalledWith(nextState));
  });
});
