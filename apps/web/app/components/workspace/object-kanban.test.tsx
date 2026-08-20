// @vitest-environment jsdom
import React from "react";
import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { buildKanbanAccordionSections, buildWorkTaskKanbanAccordionSections, ObjectKanban } from "./object-kanban";

const entries = [
  { entry_id: "t1", Title: "First", Status: "Planned", Priority: "P1", Project: "p1" },
  { entry_id: "t2", Title: "Second", Status: "In Progress", Priority: "P1", Project: "p2" },
  { entry_id: "t3", Title: "Historical", Status: "Done", Priority: "P0", Project: "p3" },
];
const projectLabels = {
  p1: "Supplier inventory lifecycle",
  p2: "Safe change delivery",
};

describe("Work Task project accordions", () => {
  it("shows the resolved assignee on Work Task cards", async () => {
    render(
      <ObjectKanban
        objectName="work_task"
        fields={[
          { id: "title", name: "Title", type: "text" },
          { id: "preview", name: "Preview", type: "text" },
          { id: "status", name: "Status", type: "enum", enum_values: ["Planned", "In Progress"] },
          { id: "priority", name: "Priority", type: "enum", enum_values: ["P0", "P1"] },
          { id: "project", name: "Project", type: "relation", related_object_name: "project" },
          { id: "repository", name: "Repository", type: "text" },
          { id: "assignee", name: "Assignee", type: "relation", related_object_name: "crm_user" },
        ]}
        entries={[{
          entry_id: "t1",
          Title: "Buyer demand context",
          Preview: "Rank buyer demand using current CRM evidence.",
          Status: "Planned",
          Priority: "P1",
          Project: "p1",
          Repository: "runtime-only",
          Assignee: "alex-user-id",
        }]}
        statuses={[]}
        relationLabels={{
          Project: { p1: "Backlog" },
          Assignee: { "alex-user-id": "alex@rebattery.io" },
        }}
        accordionGroupFieldName="Project"
      />,
    );

    await waitFor(() => expect(screen.getByText("Buyer demand context")).toBeTruthy());
    expect(screen.getByText("Assignee:")).toBeTruthy();
    expect(screen.getByText("alex@rebattery.io")).toBeTruthy();
  });

  it("builds generic sections for projects represented by the supplied tasks", () => {
    expect(buildKanbanAccordionSections(entries.slice(0, 2), "Project", projectLabels)).toEqual([
      { key: "p1", label: "Supplier inventory lifecycle", entries: [entries[0]] },
      { key: "p2", label: "Safe change delivery", entries: [entries[1]] },
    ]);
  });

  it("shows only actionable tasks in Active Projects and orders by planned work then importance", () => {
    const planned = [
      ...entries,
      { entry_id: "t4", Title: "Third", Status: "Planned", Priority: "P2", Project: "p2" },
      { entry_id: "t5", Title: "Fourth", Status: "Planned", Priority: "P1", Project: "p2" },
      { entry_id: "t6", Title: "Finished project task", Status: "Planned", Priority: "P0", Project: "finished" },
      { entry_id: "t7", Title: "Unassigned task", Status: "Planned", Priority: "P0", Project: "" },
    ];

    expect(buildWorkTaskKanbanAccordionSections(
      planned,
      "Project",
      "Status",
      "Priority",
      projectLabels,
    )).toEqual([
      { key: "p2", label: "Safe change delivery", entries: [entries[1], planned[3], planned[4]] },
      { key: "p1", label: "Supplier inventory lifecycle", entries: [entries[0]] },
    ]);
  });

  it("allows multiple project Kanbans to stay expanded", async () => {
    const user = userEvent.setup();
    render(
      <ObjectKanban
        objectName="work_task"
        fields={[
          { id: "title", name: "Title", type: "text" },
          { id: "status", name: "Status", type: "enum", enum_values: ["Planned", "In Progress", "Done", "Retired"] },
          { id: "priority", name: "Priority", type: "enum", enum_values: ["P0", "P1", "P2"] },
          { id: "project", name: "Project", type: "relation", related_object_name: "project" },
        ]}
        entries={entries}
        statuses={[]}
        relationLabels={{ Project: projectLabels }}
        accordionGroupFieldName="Project"
      />,
    );

    const supplier = screen.getByRole("button", { name: /Supplier inventory lifecycle/ });
    const delivery = screen.getByRole("button", { name: /Safe change delivery/ });
    expect(screen.queryByText("Historical")).toBeNull();
    expect(screen.queryByText("Done")).toBeNull();
    expect(screen.queryByText("Retired")).toBeNull();
    await waitFor(() => expect(supplier.getAttribute("aria-expanded")).toBe("true"));
    expect(delivery.getAttribute("aria-expanded")).toBe("false");

    await user.click(delivery);
    expect(supplier.getAttribute("aria-expanded")).toBe("true");
    expect(delivery.getAttribute("aria-expanded")).toBe("true");

    await user.click(supplier);
    expect(supplier.getAttribute("aria-expanded")).toBe("false");
    expect(delivery.getAttribute("aria-expanded")).toBe("true");
  });

  it("opens a visible project when filtering removes the previously expanded one", async () => {
    const kanban = (visibleEntries: typeof entries) => (
      <ObjectKanban
        objectName="work_task"
        fields={[
          { id: "title", name: "Title", type: "text" },
          { id: "status", name: "Status", type: "enum", enum_values: ["Planned", "In Progress", "Done", "Retired"] },
          { id: "priority", name: "Priority", type: "enum", enum_values: ["P0", "P1", "P2"] },
          { id: "project", name: "Project", type: "relation", related_object_name: "project" },
        ]}
        entries={visibleEntries}
        statuses={[]}
        relationLabels={{ Project: projectLabels }}
        accordionGroupFieldName="Project"
      />
    );

    const { rerender } = render(kanban(entries));
    await waitFor(() => expect(
      screen.getByRole("button", { name: /Supplier inventory lifecycle/ }).getAttribute("aria-expanded"),
    ).toBe("true"));

    rerender(kanban([entries[1]]));
    await waitFor(() => expect(
      screen.getByRole("button", { name: /Safe change delivery/ }).getAttribute("aria-expanded"),
    ).toBe("true"));
  });

});
