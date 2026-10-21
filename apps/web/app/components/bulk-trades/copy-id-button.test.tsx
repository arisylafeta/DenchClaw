// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CopyIdButton } from "./copy-id-button";

afterEach(() => vi.unstubAllGlobals());

it("copies the id without triggering the clickable row around it", async () => {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  const open = vi.fn();
  render(<div onClick={open}><CopyIdButton id="btd_123" /></div>);
  await userEvent.click(screen.getByRole("button", { name: "Copy ID" }));
  expect(writeText).toHaveBeenCalledWith("btd_123");
  expect(open).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "ID copied" })).toBeInTheDocument();
});

it("renders nothing without an id (loading rows)", () => {
  render(<CopyIdButton id="" />);
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});
