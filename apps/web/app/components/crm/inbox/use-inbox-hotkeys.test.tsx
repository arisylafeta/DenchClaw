// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { useInboxHotkeys, type InboxHotkeyHandlers } from "./use-inbox-hotkeys";

function makeHandlers(): InboxHotkeyHandlers {
  return {
    next: vi.fn(),
    prev: vi.fn(),
    openSelected: vi.fn(),
    back: vi.fn(),
    focusSearch: vi.fn(),
    toggleSelectedBulk: vi.fn(),
    toggleStar: vi.fn(),
    archiveSelected: vi.fn(),
    openHelp: vi.fn(),
  };
}

function HotkeyHost({ handlers, enabled }: { handlers: InboxHotkeyHandlers; enabled?: boolean }) {
  useInboxHotkeys(handlers, enabled ?? true);
  return <div data-testid="host">host</div>;
}

function fireKey(key: string, target: Element | Document = document) {
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

describe("useInboxHotkeys", () => {
  it.each(["textarea", "select"])("does not navigate while editing a %s", (tag) => {
    const handlers = makeHandlers();
    render(<HotkeyHost handlers={handlers} />);
    const field = document.createElement(tag);
    document.body.appendChild(field);
    fireKey("j", field);
    fireKey("?", field);
    expect(handlers.next).not.toHaveBeenCalled();
    expect(handlers.openHelp).not.toHaveBeenCalled();
    field.remove();
  });
  it("j and ArrowDown both trigger next", () => {
    const handlers = makeHandlers();
    render(<HotkeyHost handlers={handlers} />);
    fireKey("j");
    fireKey("ArrowDown");
    expect(handlers.next).toHaveBeenCalledTimes(2);
  });

  it("k and ArrowUp both trigger prev", () => {
    const handlers = makeHandlers();
    render(<HotkeyHost handlers={handlers} />);
    fireKey("k");
    fireKey("ArrowUp");
    expect(handlers.prev).toHaveBeenCalledTimes(2);
  });

  it("Enter and o open the selected thread", () => {
    const handlers = makeHandlers();
    render(<HotkeyHost handlers={handlers} />);
    fireKey("Enter");
    fireKey("o");
    expect(handlers.openSelected).toHaveBeenCalledTimes(2);
  });

  it("Escape calls back", () => {
    const handlers = makeHandlers();
    render(<HotkeyHost handlers={handlers} />);
    fireKey("Escape");
    expect(handlers.back).toHaveBeenCalledTimes(1);
  });

  it("'/' focuses the search input", () => {
    const handlers = makeHandlers();
    render(<HotkeyHost handlers={handlers} />);
    fireKey("/");
    expect(handlers.focusSearch).toHaveBeenCalledTimes(1);
  });

  it("x toggles bulk select on focused thread", () => {
    const handlers = makeHandlers();
    render(<HotkeyHost handlers={handlers} />);
    fireKey("x");
    expect(handlers.toggleSelectedBulk).toHaveBeenCalledTimes(1);
  });

  it("s stars the focused thread", () => {
    const handlers = makeHandlers();
    render(<HotkeyHost handlers={handlers} />);
    fireKey("s");
    expect(handlers.toggleStar).toHaveBeenCalledTimes(1);
  });

  it("? opens the help dialog", () => {
    const handlers = makeHandlers();
    render(<HotkeyHost handlers={handlers} />);
    fireKey("?");
    expect(handlers.openHelp).toHaveBeenCalledTimes(1);
  });

  it("ignores keys when typing inside an input", () => {
    const handlers = makeHandlers();
    render(
      <>
        <HotkeyHost handlers={handlers} />
        <input data-testid="input" />
      </>,
    );
    const input = document.querySelector<HTMLInputElement>('[data-testid="input"]');
    input?.focus();
    fireKey("j", input!);
    fireKey("k", input!);
    expect(handlers.next).not.toHaveBeenCalled();
    expect(handlers.prev).not.toHaveBeenCalled();
  });

  it("ignores meta-key combos (so Cmd-K passes through)", () => {
    const handlers = makeHandlers();
    render(<HotkeyHost handlers={handlers} />);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    expect(handlers.prev).not.toHaveBeenCalled();
  });

  it("disables all keys when enabled=false", () => {
    const handlers = makeHandlers();
    render(<HotkeyHost handlers={handlers} enabled={false} />);
    fireKey("j");
    fireKey("Enter");
    fireKey("/");
    expect(handlers.next).not.toHaveBeenCalled();
    expect(handlers.openSelected).not.toHaveBeenCalled();
    expect(handlers.focusSearch).not.toHaveBeenCalled();
  });
});
