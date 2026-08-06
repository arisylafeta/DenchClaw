// @vitest-environment jsdom
import React from "react";
import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { buildKanbanAccordionSections, ObjectKanban } from "./object-kanban";

const entries = [
  { entry_id: "t1", Title: "First", Status: "Planned", Project: "p1" },
  { entry_id: "t2", Title: "Second", Status: "Done", Project: "p2" },
];
const projectLabels = {
  p1: "Supplier inventory lifecycle",
  p2: "Safe change delivery",
  p3: "Email operations",
};

describe("Work Task project accordions", () => {
  it("builds sections for projects represented by the filtered tasks", () => {
    expect(buildKanbanAccordionSections(entries, "Project", projectLabels)).toEqual([
      { key: "p1", label: "Supplier inventory lifecycle", entries: [entries[0]] },
      { key: "p2", label: "Safe change delivery", entries: [entries[1]] },
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
