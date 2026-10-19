// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChatEditor } from "./chat-editor";

afterEach(cleanup);
it.each([{ compact: false, multiline: undefined }, { compact: true, multiline: true }])("reserves three actual editable lines for normal chat %j", async props => {
  const { container } = render(<ChatEditor onSubmit={vi.fn()} {...props} />);
  const editable = await screen.findByRole("textbox", { name: "Message" });
  expect(editable).toHaveAttribute("contenteditable", "true");
  expect(editable).toHaveClass("chat-editor-multiline");
  const css = container.querySelector("style")!.textContent!;
  // CSS contract, not a jsdom geometry assertion: each border-box floor includes
  // three line-heights PLUS its own vertical padding; mobile keeps 72px content.
  expect(css).toMatch(/\.chat-editor-content\.chat-editor-multiline\s*\{\s*min-height: calc\(3lh \+ 28px\)/);
  expect(css).toMatch(/\.chat-editor-content\.chat-editor-compact\.chat-editor-multiline\s*\{\s*min-height: calc\(3lh \+ 20px\)/);
  expect(css).toMatch(/@media \(max-width: 767px\)[\s\S]*min-height: 96px;[\s\S]*padding: 12px 16px;[\s\S]*line-height: 24px/);
});
it("keeps an independent compact popover editor small beside a normal chat editor", async () => {
  render(<><ChatEditor onSubmit={vi.fn()} /><ChatEditor compact onSubmit={vi.fn()} /></>);
  const fields = await screen.findAllByRole("textbox", { name: "Message" });
  expect(fields).toHaveLength(2);
  expect(fields[0]).toHaveClass("chat-editor-multiline");
  expect(fields[1]).toHaveClass("chat-editor-compact");
  expect(fields[1]).not.toHaveClass("chat-editor-multiline");
});
