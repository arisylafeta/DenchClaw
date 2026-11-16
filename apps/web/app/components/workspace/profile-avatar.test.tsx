// @vitest-environment jsdom
import React from "react";
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProfileAvatar } from "./profile-avatar";
import { bundledProfileAvatar, profileBlob } from "@/lib/profile-avatars";

describe("blob profile avatars", () => {
  afterEach(() => { vi.useRealTimers(); });

  it.each(["default", "investigator", "mailvin", "enricho", "devon", "matcha", "papajules", "sorcerer", "penny"])("draws %s as an SVG blob, not an image or the profile API", (name) => {
    const { container } = render(<ProfileAvatar name={name} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")).toBeTruthy();
    expect(container.querySelector(`[data-profile-avatar="${name}"]`)).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector("[data-working]")).toBeNull();
  });

  it("gives every known bot its own look and keeps legacy names on the same blob", () => {
    const known = ["default", "investigator", "mailvin", "enricho", "devon", "matcha", "papajules", "sorcerer", "vangrid", "penny"];
    expect(new Set(known.map((name) => JSON.stringify(profileBlob(name)))).size).toBe(known.length);
    expect(profileBlob("outbounder")).toEqual(profileBlob("mailvin"));
    expect(profileBlob("the-enricher")).toEqual(profileBlob("enricho"));
    expect(bundledProfileAvatar("outbounder")).toBe(bundledProfileAvatar("mailvin"));
    expect(bundledProfileAvatar("constructor")).toBeUndefined();
  });

  it("derives a stable look for a new profile", () => {
    expect(profileBlob("new-bot")).toEqual(profileBlob("new-bot"));
    const { container } = render(<ProfileAvatar name="new-bot" />);
    expect(container.querySelector("svg")).toBeTruthy();
  });

  it("animates only while working, then settles back to a still", () => {
    vi.useFakeTimers();
    const { container, rerender } = render(<ProfileAvatar name="devon" />);
    expect(container.querySelector("[data-working]")).toBeNull();
    rerender(<ProfileAvatar name="devon" working />);
    expect(container.querySelector("[data-working]")).toBeTruthy();
    rerender(<ProfileAvatar name="devon" working={false} />);
    expect(container.querySelector("[data-working]")).toBeNull();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(container.querySelector("[data-profile-avatar=\"devon\"] svg")).toBeTruthy();
  });

  it("runs no animation loop while idle", () => {
    const raf = vi.spyOn(window, "requestAnimationFrame");
    render(<ProfileAvatar name="devon" />);
    expect(raf).not.toHaveBeenCalled();
    raf.mockRestore();
  });

  it("stays still when the user prefers reduced motion", () => {
    const matchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({ matches: query.includes("reduce"), addEventListener() {}, removeEventListener() {} })) as never;
    try {
      const { container } = render(<ProfileAvatar name="devon" working />);
      expect(container.querySelector("[data-working]")).toBeNull();
    } finally {
      window.matchMedia = matchMedia;
    }
  });
});
