// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { MediaViewer } from "./media-viewer";

const url = "/api/workspace/raw-file?path=/ws/a.webm";

describe("MediaViewer video", () => {
  beforeEach(() => sessionStorage.clear());

  it("offers playback speeds and applies the chosen one", () => {
    const { container } = render(<MediaViewer url={url} filename="a.webm" mediaType="video" filePath="/ws/a.webm" />);
    const video = container.querySelector("video") as HTMLVideoElement;
    fireEvent.change(screen.getByLabelText("Playback speed"), { target: { value: "1.5" } });
    expect(video.playbackRate).toBe(1.5);
  });

  it("toggles play with space and seeks 5 seconds with the arrow keys", () => {
    const { container } = render(<MediaViewer url={url} filename="a.webm" mediaType="video" filePath="/ws/a.webm" />);
    const video = container.querySelector("video") as HTMLVideoElement;
    let played = 0;
    video.play = (() => { played += 1; return Promise.resolve(); }) as typeof video.play;
    Object.defineProperty(video, "duration", { value: 60, configurable: true });
    const surface = screen.getByTestId("video-surface");
    fireEvent.keyDown(surface, { key: " " });
    expect(played).toBe(1);
    video.currentTime = 10;
    fireEvent.keyDown(surface, { key: "ArrowRight" });
    expect(video.currentTime).toBe(15);
    fireEvent.keyDown(surface, { key: "ArrowLeft" });
    expect(video.currentTime).toBe(10);
  });

  it("remembers the position per file and restores it", () => {
    const first = render(<MediaViewer url={url} filename="a.webm" mediaType="video" filePath="/ws/a.webm" />);
    const video = first.container.querySelector("video") as HTMLVideoElement;
    video.currentTime = 42;
    fireEvent.pause(video);
    first.unmount();
    const second = render(<MediaViewer url={url} filename="a.webm" mediaType="video" filePath="/ws/a.webm" />);
    const again = second.container.querySelector("video") as HTMLVideoElement;
    fireEvent.loadedMetadata(again);
    expect(again.currentTime).toBe(42);
  });
});
