// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkillTemplateGallery } from "./skill-template-gallery";

describe("SkillTemplateGallery", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (url.startsWith("/api/composio/connections")) {
          return new Response(JSON.stringify({ items: [], toolkits: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.startsWith("/api/composio/toolkits")) {
          return new Response(JSON.stringify({ items: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ error: "Unexpected request" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("filters templates by search query", async () => {
    const user = userEvent.setup();

    render(
      <SkillTemplateGallery
        selectedTemplateId="icp-outreach-builder"
        onSelectTemplate={() => {}}
      />,
    );

    await user.type(screen.getByLabelText("Search templates"), "meeting prep");

    expect(
      screen.getByRole("button", { name: /Meeting Prep Brief/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /ICP Outreach Builder/i }),
    ).not.toBeInTheDocument();
  });

  it("filters templates by category chip", async () => {
    const user = userEvent.setup();

    render(
      <SkillTemplateGallery
        selectedTemplateId="icp-outreach-builder"
        onSelectTemplate={() => {}}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Prep Meetings" }));

    expect(
      screen.getByRole("button", { name: /Meeting Prep Brief/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Post-meeting Follow-through/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /ICP Outreach Builder/i }),
    ).not.toBeInTheDocument();
  });

  it("opens setup modal before calling selection callback", async () => {
    const user = userEvent.setup();
    const onSelectTemplate = vi.fn();

    render(
      <SkillTemplateGallery
        selectedTemplateId="icp-outreach-builder"
        onSelectTemplate={onSelectTemplate}
        actionLabel="Start"
      />,
    );

    const templateCard = screen.getByRole("button", {
      name: /Company Deep Researcher/i,
    });

    expect(templateCard).toHaveAccessibleName(/Start/i);

    await user.click(templateCard);

    expect(
      await screen.findByRole("heading", { name: /Company Deep Researcher/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("Connect required apps")).toBeInTheDocument();
    expect(screen.getByText("No external apps needed")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(onSelectTemplate).toHaveBeenCalledWith("company-deep-researcher");
  });

  it("requires connected external apps before starting a template", async () => {
    const user = userEvent.setup();
    const onSelectTemplate = vi.fn();

    render(
      <SkillTemplateGallery
        selectedTemplateId="icp-outreach-builder"
        onSelectTemplate={onSelectTemplate}
        actionLabel="Start"
      />,
    );

    await user.click(
      screen.getByRole("button", {
        name: /ICP Outreach Builder/i,
      }),
    );

    expect(
      await screen.findByRole("heading", { name: /ICP Outreach Builder/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Skip setup" })).not.toBeInTheDocument();
    expect(onSelectTemplate).not.toHaveBeenCalled();
  });
});
