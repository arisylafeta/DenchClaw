import { describe, expect, it, vi } from "vitest";
import {
	MAX_CHAT_IMAGE_BYTES,
} from "@/lib/chat-image-common";
import {
	prepareFilesForChatUpload,
	type ChatImagePreparationTools,
} from "./chat-image-preparation";

function makeCanvasTools(
	canvasToBlob: NonNullable<ChatImagePreparationTools["canvasToBlob"]>,
): ChatImagePreparationTools {
	return {
		loadImage: vi.fn(async () => ({
			width: 1600,
			height: 1200,
			render: vi.fn(),
			cleanup: vi.fn(),
		})),
		createCanvas: vi.fn(() => ({
			getContext: vi.fn(() => ({
				fillStyle: "",
				fillRect: vi.fn(),
				drawImage: vi.fn(),
			})),
		} as unknown as HTMLCanvasElement)),
		canvasToBlob,
	};
}

describe("prepareFilesForChatUpload", () => {
	it.each([
		["small.png", "image/png"],
		["small.jpg", "image/jpeg"],
		["small.gif", "image/gif"],
		["small.webp", "image/webp"],
		["small.bmp", "image/bmp"],
		["small.PNG", ""],
	])("keeps model-safe image files unchanged (%s, %s)", async (name, type) => {
		const file = new File(["small"], name, { type });

		const result = await prepareFilesForChatUpload([file]);

		expect(result.errors).toEqual([]);
		expect(result.files).toEqual([file]);
	});

	it("converts unsupported image formats into model-safe uploads", async () => {
		const file = new File(["heic"], "portrait.heic", { type: "image/heic" });
		const tools = makeCanvasTools(async (_canvas, type) =>
			new Blob(["compressed"], { type }),
		);

		const result = await prepareFilesForChatUpload([file], tools);

		expect(result.errors).toEqual([]);
		expect(result.files).toHaveLength(1);
		expect(result.files[0]?.type).toBe("image/jpeg");
		expect(result.files[0]?.name).toBe("portrait.jpg");
	});

	it("reports an error when an image cannot be reduced below the size budget", async () => {
		const file = new File(
			[new Uint8Array(MAX_CHAT_IMAGE_BYTES + 16)],
			"huge.jpg",
			{ type: "image/jpeg" },
		);
		const tools = makeCanvasTools(async (_canvas, type) =>
			new Blob([new Uint8Array(MAX_CHAT_IMAGE_BYTES + 16)], { type }),
		);

		const result = await prepareFilesForChatUpload([file], tools);

		expect(result.files).toEqual([]);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain("Please choose a smaller PNG or JPEG under 5 MB.");
	});
});
