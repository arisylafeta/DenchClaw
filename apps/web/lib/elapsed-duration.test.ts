import { describe, expect, it } from "vitest";
import { formatElapsedDuration } from "./elapsed-duration";

describe("formatElapsedDuration", () => {
  it.each([
    [0, "0s"], [0.999, "0s"], [59.999, "59s"], [60, "60s"],
    [119, "119s"], [119.999, "119s"], [120, "2m 0s"], [126, "2m 6s"],
    [126.999, "2m 6s"], [3599, "59m 59s"], [3599.999, "59m 59s"],
    [3600, "1h 0m"], [3659.999, "1h 0m"], [3840, "1h 4m"],
    [7199, "1h 59m"], [7200, "2h 0m"], [90061, "25h 1m"],
    [-1, "0s"], [-0.1, "0s"], [NaN, "0s"], [Infinity, "0s"], [-Infinity, "0s"],
  ])("formats %s seconds as %s", (seconds, expected) => {
    expect(formatElapsedDuration(seconds)).toBe(expected);
  });
});
