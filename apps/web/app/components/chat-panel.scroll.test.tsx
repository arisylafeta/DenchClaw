// @vitest-environment jsdom

import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatPanel } from "./chat-panel";

describe("ChatPanel bottom pinning", () => {
	let resizeCallbacks: ResizeObserverCallback[];
	let rafCallbacks: FrameRequestCallback[];

	beforeEach(() => {
		vi.useFakeTimers();
		resizeCallbacks = [];
		rafCallbacks = [];

		class FakeResizeObserver {
			constructor(callback: ResizeObserverCallback) {
				resizeCallbacks.push(callback);
			}
			observe() {}
			unobserve() {}
			disconnect() {}
		}

		vi.stubGlobal("ResizeObserver", FakeResizeObserver);
		vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
			rafCallbacks.push(callback);
			return rafCallbacks.length;
		});
		vi.stubGlobal("cancelAnimationFrame", vi.fn());
		vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
			if (String(input).includes("/api/settings/cloud")) {
				return new Response(JSON.stringify({ status: "no_key" }), { status: 200 });
			}
			return new Response(null, { status: 404 });
		}));
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("stays pinned when content grows during a downward wheel gesture", async () => {
		const { container } = render(
			<ChatPanel sessionKey="agent:main:subagent:test" subagentTask="Test scroll" />,
		);
		const scroller = container.querySelector<HTMLDivElement>(".overflow-y-auto");
		expect(scroller).not.toBeNull();
		if (!scroller) return;

		let scrollHeight = 1400;
		let scrollTop = 800;
		Object.defineProperties(scroller, {
			clientHeight: { configurable: true, get: () => 600 },
			scrollHeight: { configurable: true, get: () => scrollHeight },
			scrollTop: {
				configurable: true,
				get: () => scrollTop,
				set: (value: number) => { scrollTop = value; },
			},
			scrollTo: {
				configurable: true,
				value: ({ top }: ScrollToOptions) => {
					scrollTop = Math.min(Number(top), scrollHeight - 600);
				},
			},
		});

		await act(async () => {
			while (rafCallbacks.length) rafCallbacks.shift()?.(performance.now());
		});
		scrollTop = 800;

		await act(async () => {
			scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: 20 }));
			scrollHeight = 1500;
			for (const callback of resizeCallbacks) callback([], {} as ResizeObserver);
			while (rafCallbacks.length) rafCallbacks.shift()?.(performance.now());
			vi.advanceTimersByTime(201);
		});

		expect(scrollTop).toBe(900);
	});
});
