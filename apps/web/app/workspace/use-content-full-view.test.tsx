// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { useCallback, useState } from "react";
import { describe, expect, it } from "vitest";
import type { WorkspacePanelLayout } from "./content-layout";
import { useContentFullView } from "./use-content-full-view";

const initialLayout: WorkspacePanelLayout = {
  chatPanelCollapsed: false,
  fileTreeCollapsed: false,
  rightPanelCollapsed: false,
};

describe("useContentFullView", () => {
  it("claims the canvas while active and restores the previous layout on exit", async () => {
    const { result, rerender } = renderHook(
      ({ active }) => {
        const [layout, setLayout] = useState(initialLayout);
        const applyLayout = useCallback((next: WorkspacePanelLayout) => setLayout(next), []);
        const suspendPersistence = useContentFullView({ active, layout, applyLayout });
        return { layout, setLayout, suspendPersistence };
      },
      { initialProps: { active: false } },
    );

    rerender({ active: true });
    await waitFor(() => {
      expect(result.current.layout).toEqual({
        chatPanelCollapsed: true,
        fileTreeCollapsed: true,
        rightPanelCollapsed: false,
      });
      expect(result.current.suspendPersistence).toBe(true);
    });

    act(() => result.current.setLayout({
      chatPanelCollapsed: false,
      fileTreeCollapsed: true,
      rightPanelCollapsed: false,
    }));
    rerender({ active: false });

    await waitFor(() => {
      expect(result.current.layout).toEqual(initialLayout);
      expect(result.current.suspendPersistence).toBe(false);
    });
  });
});
