// @vitest-environment jsdom
import { useRef } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useWorkspaceVisualViewport } from "./use-workspace-visual-viewport";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function Shell() {
  const ref = useRef<HTMLDivElement>(null);
  useWorkspaceVisualViewport(ref);
  return <div ref={ref} data-testid="shell" />;
}
it("resizes the narrow shell for the keyboard, ignores pinch zoom, restores desktop and cleans up", () => {
  const viewport = Object.assign(new EventTarget(), { height: 800, scale: 1 });
  const media = Object.assign(new EventTarget(), { matches: true });
  vi.stubGlobal("visualViewport", viewport);
  vi.stubGlobal("matchMedia", vi.fn(() => media));
  const { unmount } = render(<Shell />);
  const shell = screen.getByTestId("shell");
  const height = () => shell.style.getPropertyValue("--workspace-visible-height");
  expect(height()).toBe("800px");
  act(() => { viewport.height = 360; viewport.dispatchEvent(new Event("resize")); });
  expect(height()).toBe("360px");
  act(() => { viewport.scale = 2; viewport.height = 180; viewport.dispatchEvent(new Event("resize")); });
  expect(height()).toBe("360px");
  act(() => { media.matches = false; media.dispatchEvent(new Event("change")); });
  expect(height()).toBe("");
  act(() => { viewport.scale = 1; viewport.height = 700; media.matches = true; media.dispatchEvent(new Event("change")); });
  expect(height()).toBe("700px");
  unmount();
  expect(height()).toBe("");
  viewport.dispatchEvent(new Event("resize"));
  expect(height()).toBe("");
});
it("keeps the CSS viewport fallback when the visual viewport API is unavailable", () => {
  vi.stubGlobal("visualViewport", undefined);
  render(<Shell />);
  expect(screen.getByTestId("shell").style.getPropertyValue("--workspace-visible-height")).toBe("");
});
it("pins the shell to the visible area when iOS pans the page for the keyboard", () => {
  const viewport = Object.assign(new EventTarget(), { height: 400, scale: 1, offsetTop: 0 });
  vi.stubGlobal("visualViewport", viewport);
  vi.stubGlobal("matchMedia", vi.fn(() => Object.assign(new EventTarget(), { matches: true })));
  render(<Shell />);
  const shell = screen.getByTestId("shell");
  expect(shell.style.getPropertyValue("--workspace-visible-top")).toBe("0px");
  act(() => { viewport.offsetTop = 120; viewport.dispatchEvent(new Event("scroll")); });
  expect(shell.style.getPropertyValue("--workspace-visible-top")).toBe("120px");
});
