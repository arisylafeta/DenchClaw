// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatVoiceInputButton } from "./chat-voice-input-button";

class FakeSpeechRecognition {
  continuous = false;
  interimResults = false;
  maxAlternatives = 1;
  lang?: string;
  onend: (() => void) | null = null;
  onerror: ((event: { error?: string }) => void) | null = null;
  onresult: ((event: { resultIndex: number; results: unknown[] }) => void) | null = null;
  start = vi.fn();
  stop = vi.fn(() => {
    this.onend?.();
  });
}

describe("ChatVoiceInputButton", () => {
  let lastRecognition: FakeSpeechRecognition | null = null;

  beforeEach(() => {
    lastRecognition = null;
    vi.restoreAllMocks();
    Object.defineProperty(window, "webkitSpeechRecognition", {
      configurable: true,
      writable: true,
      value: class extends FakeSpeechRecognition {
        constructor() {
          super();
          lastRecognition = this;
        }
      },
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(window, "MediaRecorder", {
      configurable: true,
      writable: true,
      value: undefined,
    });
  });

  it("falls back to browser speech recognition when server transcription cannot be used", async () => {
    const onTranscript = vi.fn();

    render(
      <ChatVoiceInputButton
        preferServerTranscription
        onTranscript={onTranscript}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Start voice input" }));

    expect(lastRecognition?.start).toHaveBeenCalledTimes(1);

    lastRecognition?.onresult?.({
      resultIndex: 0,
      results: [Object.assign([{ transcript: "voice from browser" }], { isFinal: true })],
    });
    lastRecognition?.onend?.();

    await waitFor(() => {
      expect(onTranscript).toHaveBeenCalledWith("voice from browser");
    });
  });

  it("shows why voice input failed when the microphone is blocked", async () => {
    render(<ChatVoiceInputButton preferServerTranscription={false} onTranscript={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Start voice input" }));
    lastRecognition?.onerror?.({ error: "not-allowed" });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Microphone access is blocked/ })).toBeTruthy();
    });
  });
});
