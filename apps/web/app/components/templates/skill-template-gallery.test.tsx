// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SkillTemplateGallery } from "./skill-template-gallery";

describe("SkillTemplateGallery", () => {
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
      screen.getByRole("article", { name: /Meeting Prep Brief/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("article", { name: /ICP Outreach Builder/i }),
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
      screen.getByRole("article", { name: /Meeting Prep Brief/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("article", { name: /Post-meeting Follow-through/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("article", { name: /ICP Outreach Builder/i }),
    ).not.toBeInTheDocument();
  });

  it("calls selection when the template action button is clicked", async () => {
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
      screen.getByRole("button", { name: /Start Company Deep Researcher/i }),
    );

    expect(onSelectTemplate).toHaveBeenCalledWith("company-deep-researcher");
    expect(screen.queryByText("Connect required apps")).not.toBeInTheDocument();
  });

  it("does not block templates that list required apps", async () => {
    const user = userEvent.setup();
    const onSelectTemplate = vi.fn();

    render(
      <SkillTemplateGallery
        selectedTemplateId="company-deep-researcher"
        onSelectTemplate={onSelectTemplate}
        actionLabel="Start"
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /Start ICP Outreach Builder/i }),
    );

    expect(onSelectTemplate).toHaveBeenCalledWith("icp-outreach-builder");
    expect(screen.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();
  });
});
