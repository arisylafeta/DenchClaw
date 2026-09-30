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

describe("Kanban column visibility", () => {
  it("keeps terminal values available while hiding configured columns", () => {
    render(
      <ObjectKanban
        objectName="bulk_trade"
        fields={[
          { id: "title", name: "Title", type: "text" },
          {
            id: "stage",
            name: "Stage",
            type: "enum",
            enum_values: ["Sourced", "In Campaign", "In Conversation", "In Payment", "In Collection", "Completed"],
          },
        ]}
        entries={[
          { entry_id: "trade-1", Title: "Active lot", Stage: "Sourced" },
        ]}
        statuses={[]}
        groupFieldName="Stage"
        hiddenColumns={["Completed"]}
      />,
    );

    expect(screen.getByText("Sourced")).toBeTruthy();
    expect(screen.getByText("In Payment")).toBeTruthy();
    expect(screen.getByText("In Collection")).toBeTruthy();
    expect(screen.queryByText("Completed")).toBeNull();
  });
});

describe("folded columns", () => {
  const stageFields = [
    { id: "name", name: "Name", type: "text" },
    { id: "stage", name: "Stage", type: "enum", enum_values: ["Found", "Contacted", "Parked"] },
  ];
  const stageEntries = [
    { entry_id: "d1", Name: "Backlog one", Stage: "Found" },
    { entry_id: "d2", Name: "Backlog two", Stage: "Found" },
    { entry_id: "d3", Name: "In talks", Stage: "Contacted" },
  ];

  it("starts the given columns folded, opens on click, and remembers the choice", async () => {
    window.localStorage.clear();
    const board = () => (
      <ObjectKanban objectName="dismantler" fields={stageFields} entries={stageEntries} statuses={[]}
        collapsedColumns={["Found", "Parked"]} />
    );
    const { unmount } = render(board());

    expect(screen.getByText("In talks")).toBeTruthy();
    expect(screen.queryByText("Backlog one")).toBeNull();
    const found = screen.getByRole("button", { name: "Open Found, 2 entries" });
    expect(screen.getByRole("button", { name: "Open Parked, 0 entries" })).toBeTruthy();

    await userEvent.click(found);
    expect(screen.getByText("Backlog one")).toBeTruthy();
    unmount();

    render(board());
    expect(screen.getByText("Backlog two")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Fold Contacted" }));
    expect(screen.queryByText("In talks")).toBeNull();
    expect(JSON.parse(window.localStorage.getItem("kanban-collapsed:dismantler")!)).toEqual(["Parked", "Contacted"]);
  });

  it("shows compact columns as one-line rows that unfold, then open on a second click", async () => {
    window.localStorage.clear();
    const opened: string[] = [];
    const fields = [...stageFields, { id: "next", name: "Next step", type: "text" }];
    render(
      <ObjectKanban objectName="dismantler" fields={fields} statuses={[]} compactCardColumns={["Found"]}
        entries={[
          { entry_id: "d1", Name: "Backlog one", Stage: "Found", "Next step": "Find a contact" },
          { entry_id: "d3", Name: "In talks", Stage: "Contacted", "Next step": "Book a call" },
        ]}
        onEntryClick={(id) => opened.push(id)} />,
    );
    expect(screen.getByText("Book a call")).toBeTruthy();
    expect(screen.queryByText("Find a contact")).toBeNull();

    await userEvent.click(screen.getByText("Backlog one"));
    expect(screen.getByText("Find a contact")).toBeTruthy();
    expect(opened).toEqual([]);

    await userEvent.click(screen.getByText("Find a contact"));
    expect(opened).toEqual(["d1"]);
    await userEvent.click(screen.getByRole("button", { name: "Hide details for Backlog one" }));
    expect(screen.queryByText("Find a contact")).toBeNull();
    expect(opened).toEqual(["d1"]);
  });

  it("folds nothing by default", () => {
    window.localStorage.clear();
    render(<ObjectKanban objectName="other" fields={stageFields} entries={stageEntries} statuses={[]} />);
    expect(screen.getByText("Backlog one")).toBeTruthy();
    expect(screen.getByText("In talks")).toBeTruthy();
  });
});
