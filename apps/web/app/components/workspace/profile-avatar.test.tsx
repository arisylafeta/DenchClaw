// @vitest-environment jsdom
import React from "react";
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProfileAvatar } from "./profile-avatar";
import { bundledProfileAvatar } from "@/lib/profile-avatars";

describe("bundled profile avatars", () => {
  it.each(["default", "investigator", "mailvin", "enricho", "devon", "matcha"])("uses a bundled WebP rather than the profile API for %s", (name) => {
    const { container } = render(<ProfileAvatar name={name} />);
    const image = container.querySelector("img")!;
    expect(image.getAttribute("src")).toBe(bundledProfileAvatar(name));
    expect(image.getAttribute("src")).toMatch(/\.webp/);
    expect(image.getAttribute("src")).not.toContain("/api/");
    expect(image.parentElement).toHaveClass("rounded-full");
    expect(image).toHaveAttribute("width", "64");
    expect(image).toHaveAttribute("height", "64");
  });

  it("preserves avatar identity for historical profile names", () => {
    expect(bundledProfileAvatar("outbounder")).toBe(bundledProfileAvatar("mailvin"));
    expect(bundledProfileAvatar("the-enricher")).toBe(bundledProfileAvatar("enricho"));
    expect(bundledProfileAvatar("constructor")).toBeUndefined();
  });

  it("uses the dynamic fallback for a new profile and initials on load failure", () => {
    const { container, rerender } = render(<ProfileAvatar name="new-bot" />);
    const image = container.querySelector("img")!;
    expect(image).toHaveAttribute("src", "/api/workspace/avatar?name=new-bot");
    fireEvent.error(image);
    expect(container.querySelector("img")).toBeNull();
    expect(container).toHaveTextContent("NB");
    rerender(<ProfileAvatar name="mailvin" />);
    expect(container.querySelector("img")).toHaveAttribute("src", bundledProfileAvatar("mailvin"));
  });
});
