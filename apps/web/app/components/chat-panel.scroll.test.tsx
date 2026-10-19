// @vitest-environment jsdom

import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatPanel } from "./chat-panel";

describe("ChatPanel bottom pinning", () => {
	let resizeCallbacks: ResizeObserverCallback[];
	let rafCallbacks: FrameRequestCallback[];
	let observedElements: Element[];

	beforeEach(() => {
		vi.useFakeTimers();
		resizeCallbacks = [];
		rafCallbacks = [];
		observedElements = [];

		class FakeResizeObserver {
			constructor(callback: ResizeObserverCallback) {
				resizeCallbacks.push(callback);
			}
			observe(element: Element) { observedElements.push(element); }
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

	it.each([true, false])("tracks dock growth and collapse while pinned=%s", async (pinned) => {
		const { container } = render(
			<ChatPanel sessionKey="agent:main:subagent:test" subagentTask="Test dock" />,
		);
		const composer = container.querySelector<HTMLDivElement>("[data-chat-composer-position]")!;
		const scroller = container.querySelector<HTMLDivElement>(".overflow-y-auto")!;
		expect(observedElements).toContain(composer);
		let height = 140;
		vi.spyOn(composer, "getBoundingClientRect").mockImplementation(() => ({ height }) as DOMRect);
		const scrollTo = vi.fn();
		Object.defineProperties(scroller, {
			clientHeight: { configurable: true, value: 600 },
			scrollHeight: { configurable: true, get: () => 1000 + height },
			scrollTop: { configurable: true, value: 0, writable: true },
			scrollTo: { configurable: true, value: scrollTo },
		});
		await act(async () => {
			while (rafCallbacks.length) rafCallbacks.shift()?.(performance.now());
		});
		if (!pinned) {
			await act(async () => {
				scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
				scroller.dispatchEvent(new Event("scroll"));
				vi.advanceTimersByTime(201);
			});
		}
		for (const nextHeight of [360, 140]) {
			scrollTo.mockClear();
			await act(async () => {
				height = nextHeight;
				for (const callback of resizeCallbacks) callback([], {} as ResizeObserver);
				while (rafCallbacks.length) rafCallbacks.shift()?.(performance.now());
			});
			expect(scroller.style.paddingBottom).toBe("var(--chat-composer-height, 140px)");
			expect(scroller.style.getPropertyValue("--chat-composer-height")).toBe(`${height}px`);
			if (pinned) expect(scrollTo).toHaveBeenCalledWith({ top: 1000 + height, behavior: "auto" });
			else expect(scrollTo).not.toHaveBeenCalled();
		}
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
