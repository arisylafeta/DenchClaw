import { describe, expect, it, vi } from "vitest";
import { readOnboardingResponse } from "./response";

describe("onboarding response helpers", () => {
  it("uses native json parsing for normal Response-like objects", async () => {
    const res = {
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ currentStep: "complete" }),
      text: vi.fn().mockRejectedValue(new Error("text path should not be used")),
    } as unknown as Response;

    await expect(readOnboardingResponse(res)).resolves.toEqual({
      currentStep: "complete",
    });
    expect(res.json).toHaveBeenCalledOnce();
    expect(res.text).not.toHaveBeenCalled();
  });

  it("does not turn successful JSON parse failures into empty data", async () => {
    const res = {
      ok: true,
      status: 200,
      json: vi.fn().mockRejectedValue(new SyntaxError("Unexpected end of JSON input")),
      text: vi.fn(),
    } as unknown as Response;

    await expect(readOnboardingResponse(res)).rejects.toThrow(
      "Expected a JSON response.",
    );
  });
});
