// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OnboardingState } from "@/lib/denchclaw-state";
import { SetupStep } from "./setup-step";

const baseState: OnboardingState = {
  version: 1,
  currentStep: "connect-gmail",
  completedSteps: ["welcome", "identity", "dench-cloud"],
  identity: {
    name: "Vedant",
    email: "vedant@example.com",
    capturedAt: "2026-04-29T18:45:14.895Z",
  },
  denchCloud: {
    source: "cli",
    skipped: false,
    configuredAt: "2026-04-29T18:45:15.517Z",
  },
  startedAt: "2026-04-29T18:45:14.580Z",
  updatedAt: "2026-04-29T18:45:15.517Z",
};

function Harness({ onAdvance }: { onAdvance: (state: OnboardingState) => void }) {
  const [state, setState] = useState(baseState);
  return (
    <SetupStep
      state={state}
      onAdvance={(next) => {
        setState(next);
        onAdvance(next);
      }}
      onRefresh={async () => {}}
      onStageChange={() => {}}
    />
  );
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
}

describe("SetupStep", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("adopts an existing active Gmail connection before asking the user to connect", async () => {
    const onAdvance = vi.fn();
    const nextState: OnboardingState = {
      ...baseState,
      currentStep: "connect-calendar",
      completedSteps: ["welcome", "identity", "dench-cloud", "connect-gmail"],
      connections: {
        gmail: {
          connectionId: "ca_existing_gmail",
          toolkitSlug: "gmail",
          accountEmail: "person@example.com",
          connectedAt: "2026-04-30T00:00:00.000Z",
        },
      },
    };
    const bodies: unknown[] = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url === "/api/onboarding/dench-cloud") {
        return new Response(JSON.stringify({
          configured: true,
          source: "cli",
          primaryModel: "dench-cloud/gpt-5.5",
        }));
      }
      if (url === "/api/composio/connections?include_toolkits=1&fresh=1") {
        return new Response(JSON.stringify({
          connections: [
            {
              id: "ca_existing_gmail",
              toolkit_slug: "gmail",
              toolkit_name: "Gmail",
              status: "ACTIVE",
              account_email: "person@example.com",
              created_at: "2026-04-30T00:00:00.000Z",
            },
          ],
        }));
      }
      if (url === "/api/onboarding/connections") {
        if (typeof init?.body !== "string") {
          throw new Error("Expected string JSON body.");
        }
        bodies.push(JSON.parse(init.body));
        return new Response(JSON.stringify(nextState));
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    render(<Harness onAdvance={onAdvance} />);

    await waitFor(() => {
      expect(onAdvance).toHaveBeenCalledWith(nextState);
    });
    expect(bodies).toEqual([
      {
        toolkit: "gmail",
        connectionId: "ca_existing_gmail",
        toolkitSlug: "gmail",
        accountEmail: "person@example.com",
        fromStep: "connect-gmail",
        toStep: "connect-calendar",
      },
    ]);
    expect(await screen.findByText("person@example.com")).toBeInTheDocument();
  });

  it("uses the Gmail reconciliation result when adopting Calendar in the same pass", async () => {
    const onAdvance = vi.fn();
    const gmailState: OnboardingState = {
      ...baseState,
      currentStep: "connect-calendar",
      completedSteps: ["welcome", "identity", "dench-cloud", "connect-gmail"],
      connections: {
        gmail: {
          connectionId: "ca_existing_gmail",
          toolkitSlug: "gmail",
          accountEmail: "person@example.com",
          connectedAt: "2026-04-30T00:00:00.000Z",
        },
      },
    };
    const calendarState: OnboardingState = {
      ...gmailState,
      currentStep: "backfill",
      completedSteps: [
        "welcome",
        "identity",
        "dench-cloud",
        "connect-gmail",
        "connect-calendar",
      ],
      connections: {
        ...gmailState.connections,
        calendar: {
          connectionId: "ca_existing_calendar",
          toolkitSlug: "google-calendar",
          accountEmail: "person@example.com",
          connectedAt: "2026-04-30T00:00:00.000Z",
        },
      },
    };
    const bodies: unknown[] = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url === "/api/onboarding/dench-cloud") {
        return new Response(JSON.stringify({
          configured: true,
          source: "cli",
          primaryModel: "dench-cloud/gpt-5.5",
        }));
      }
      if (url === "/api/composio/connections?include_toolkits=1&fresh=1") {
        return new Response(JSON.stringify({
          connections: [
            {
              id: "ca_existing_gmail",
              toolkit_slug: "gmail",
              toolkit_name: "Gmail",
              status: "ACTIVE",
              account_email: "person@example.com",
              created_at: "2026-04-30T00:00:00.000Z",
            },
            {
              id: "ca_existing_calendar",
              toolkit_slug: "google-calendar",
              toolkit_name: "Google Calendar",
              status: "ACTIVE",
              account_email: "person@example.com",
              created_at: "2026-04-30T00:00:00.000Z",
            },
          ],
        }));
      }
      if (url === "/api/onboarding/connections") {
        if (typeof init?.body !== "string") {
          throw new Error("Expected string JSON body.");
        }
        const body = JSON.parse(init.body) as { toolkit: string };
        bodies.push(body);
        return new Response(JSON.stringify(body.toolkit === "gmail" ? gmailState : calendarState));
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    render(<Harness onAdvance={onAdvance} />);

    await waitFor(() => {
      expect(bodies).toHaveLength(2);
    });
    expect(bodies).toEqual([
      expect.objectContaining({
        toolkit: "gmail",
        fromStep: "connect-gmail",
        toStep: "connect-calendar",
      }),
      expect.objectContaining({
        toolkit: "calendar",
        fromStep: "connect-calendar",
        toStep: "backfill",
      }),
    ]);
    expect(onAdvance).toHaveBeenLastCalledWith(calendarState);
  });

  it("routes Gmail skip users to starter skill selection", async () => {
    const user = userEvent.setup();
    const onAdvance = vi.fn();
    const nextState: OnboardingState = {
      ...baseState,
      currentStep: "skill-template",
      completedSteps: ["welcome", "identity", "dench-cloud", "connect-gmail"],
    };
    const bodies: unknown[] = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url === "/api/onboarding/dench-cloud") {
        return new Response(JSON.stringify({
          configured: true,
          source: "cli",
          primaryModel: "dench-cloud/gpt-5.5",
        }));
      }
      if (url === "/api/composio/connections?include_toolkits=1&fresh=1") {
        return new Response(JSON.stringify({ connections: [] }));
      }
      if (url === "/api/onboarding/state") {
        if (typeof init?.body !== "string") {
          throw new Error("Expected string JSON body.");
        }
        bodies.push(JSON.parse(init.body));
        return new Response(JSON.stringify(nextState));
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    render(<Harness onAdvance={onAdvance} />);

    await user.click(await screen.findByRole("button", { name: "Skip" }));
    await user.click(
      await screen.findByRole("button", { name: "Yes, choose a starter skill" }),
    );

    await waitFor(() => {
      expect(onAdvance).toHaveBeenCalledWith(nextState);
    });
    expect(bodies).toEqual([
      {
        from: "connect-gmail",
        to: "skill-template",
        skipping: "gmail",
      },
    ]);
  });
});
