// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { InboxLayout } from "./inbox-layout";
import { MailLine, MailLineSkeleton } from "./mail-line";

const layout = (hasSelection = true) => <InboxLayout hasSelection={hasSelection} list={<div>the list</div>} conversation={<div>the open item</div>} />;

describe("collapsible list", () => {
  it("hides and restores the list from the handle so the open item can fill the pane", () => {
    render(layout());
    expect(screen.getByText("the list")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hide list" }));
    expect(screen.queryByText("the list")).not.toBeInTheDocument();
    expect(screen.getByText("the open item")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show list" }));
    expect(screen.getByText("the list")).toBeInTheDocument();
  });
  it("collapses when the divider is dragged well past the minimum width, but not for a small drag", () => {
    render(layout());
    const divider = screen.getByRole("separator");
    fireEvent.mouseDown(divider, { clientX: 420 });
    fireEvent.mouseMove(window, { clientX: 380 });
    expect(screen.getByText("the list")).toBeInTheDocument();
    fireEvent.mouseMove(window, { clientX: 100 });
    fireEvent.mouseUp(window);
    expect(screen.queryByText("the list")).not.toBeInTheDocument();
  });
  it("offers no handle and always shows the list when nothing is open", () => {
    render(layout(false));
    expect(screen.queryByRole("button", { name: "Hide list" })).not.toBeInTheDocument();
    expect(screen.getByText("the list")).toBeInTheDocument();
  });
});

describe("skeletons keep the real structure", () => {
  it("renders a MailLine skeleton with the same grid, padding and divider as the real row", () => {
    const { container } = render(<div><MailLine id="x" name="Someone" email={null} subject="Hello" at={null} /><MailLineSkeleton /></div>);
    const [real, skeleton] = Array.from(container.firstElementChild!.children) as HTMLElement[];
    expect(skeleton.className).toContain("px-4 py-2.5");
    expect(skeleton.className).toContain("grid");
    for (const property of ["gridTemplateColumns", "borderBottom"] as const) { expect(skeleton.style[property]).toBe(real.style[property]); }
    expect(skeleton).toHaveAttribute("aria-hidden", "true");
  });
});
