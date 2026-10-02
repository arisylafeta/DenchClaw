// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { TableCellContent } from "./table-cell";
import { FormattedFieldValue } from "../workspace/formatted-field-value";
import { ObjectTable } from "../workspace/object-table";

let availableWidth = 120;
let resize = () => {};
const observed = new Set<Element>();
beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) {
      resize = () => callback(Array.from(observed, target => ({ target }) as ResizeObserverEntry), this as unknown as ResizeObserver);
    }
    observe(target: Element) { observed.add(target); }
    unobserve(target: Element) { observed.delete(target); }
    disconnect() { observed.clear(); }
  });
});
beforeEach(() => {
  availableWidth = 120;
  // jsdom has no layout engine; expose an overflowing measured value, not a mocked disclosure.
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => availableWidth);
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.dataset.tablePart === "cell-value" && this.textContent?.includes("Overflow") ? 240 : 80;
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(20);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(20);
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
afterAll(() => vi.unstubAllGlobals());

it("reveals overflowing content without activating the row and collapses by repeat click or Escape", async () => {
  const user = userEvent.setup();
  const activate = vi.fn();
  render(<div role="button" tabIndex={0} onClick={activate}><TableCellContent><FormattedFieldValue value={"Overflow first line\nsecond line"} fieldType="richtext" /></TableCellContent></div>);
  const button = screen.getByRole("button", { name: "Expand cell content" });
  const value = document.getElementById(button.getAttribute("aria-controls")!)!;
  expect(button).toHaveAttribute("aria-expanded", "false");
  await user.click(value);
  expect(button).toHaveAttribute("aria-expanded", "true");
  expect(value).toHaveTextContent("second line");
  expect(activate).not.toHaveBeenCalled();
  await user.keyboard("{Escape}");
  expect(button).toHaveAttribute("aria-expanded", "false");
  await user.click(value);
  expect(button).toHaveAttribute("aria-expanded", "true");
  await user.click(value);
  expect(button).toHaveAttribute("aria-expanded", "false");
  button.focus();
  await user.keyboard("{Enter}");
  expect(button).toHaveAttribute("aria-expanded", "true");
  await user.keyboard("{Escape}");
  expect(button).toHaveAttribute("aria-expanded", "false");
  expect(button).toHaveFocus();
  expect(activate).not.toHaveBeenCalled();
});

it("keeps links and controls independent of disclosure", async () => {
  const user = userEvent.setup();
  render(<TableCellContent><div>Overflow note</div><a href="https://example.test/record" onClick={event => event.preventDefault()}>Record</a><button>Action</button><input aria-label="Edit note" /></TableCellContent>);
  const disclosure = screen.getByRole("button", { name: "Expand cell content" });
  await user.click(screen.getByRole("link", { name: "Record" }));
  expect(disclosure).toHaveAttribute("aria-expanded", "false");
  await user.click(screen.getByRole("button", { name: "Action" }));
  expect(disclosure).toHaveAttribute("aria-expanded", "false");
  await user.type(screen.getByRole("textbox", { name: "Edit note" }), "changed");
  expect(screen.getByRole("textbox")).toHaveValue("changed");
  expect(disclosure).toHaveAttribute("aria-expanded", "false");
});

it("does not consume selection shortcuts and removes disclosure when a resized column fits", async () => {
  const user = userEvent.setup();
  render(<TableCellContent>Overflow note</TableCellContent>);
  const disclosure = screen.getByRole("button", { name: "Expand cell content" });
  await user.keyboard("{Shift>}");
  await user.click(screen.getByText("Overflow note"));
  await user.keyboard("{/Shift}");
  expect(disclosure).toHaveAttribute("aria-expanded", "false");
  availableWidth = 300;
  act(() => resize());
  await waitFor(() => expect(screen.queryByRole("button", { name: "Expand cell content" })).toBeNull());
});

it("reveals all retained tags, collapses their preview and preserves tag editing", async () => {
  const user = userEvent.setup();
  const tags = ["Buyer", "Supplier", "Research", "Local", "Modules", "Cells", "Repurposer"];
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ available: false, ok: true })));
  render(<ObjectTable objectName="people" hideInternalToolbar fields={[{ id: "tags", name: "Tags", type: "tags", enum_multiple: true }]} entries={[{ entry_id: "p1", Tags: tags }]} />);
  const cell = screen.getByText("Buyer").closest("td")!;
  const disclosure = within(cell).getByRole("button", { name: "Expand cell content" });
  expect(within(cell).queryByText("Repurposer")).toBeNull();
  await user.click(disclosure);
  for (const tag of tags) { expect(within(cell).getByText(tag)).toBeInTheDocument(); }
  await user.click(disclosure);
  expect(within(cell).queryByText("Repurposer")).toBeNull();
  fireEvent.doubleClick(screen.getByText("Buyer").closest("div")!);
  const finalTag = within(cell).getByText("Repurposer").closest("span")!;
  await user.click(finalTag.querySelector("button")!);
  await waitFor(() => expect(within(cell).queryByText("Repurposer")).toBeNull());
  for (const tag of tags.slice(0, -1)) { expect(within(cell).getByText(tag)).toBeInTheDocument(); }
});

it("retains actionable per-line email and URL values even when the collapsed note fits", () => {
  render(<TableCellContent><FormattedFieldValue value={"Contact\nsales@example.test\nhttps://example.test/catalog"} fieldType="richtext" linkInteractionMode="button" /></TableCellContent>);
  const links = screen.getAllByRole("link");
  expect(links.map(link => link.getAttribute("href"))).toEqual(["mailto:sales@example.test", "https://example.test/catalog"]);
  expect(screen.queryByRole("button", { name: "Expand cell content" })).toBeNull();
});
