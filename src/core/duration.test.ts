import { describe, expect, it } from "vitest";

import { formatDuration } from "./duration.ts";

describe("formatDuration", () => {
  it.each([
    [0, "0ms"],
    [450, "450ms"],
    [999, "999ms"],
    [999.6, "1.0s"],
    [1_000, "1.0s"],
    [38_196, "38.2s"],
    [59_940, "59.9s"],
    [59_950, "1m 0s"],
    [59_999, "1m 0s"],
    [60_000, "1m 0s"],
    [246_000, "4m 6s"],
    [3_599_000, "59m 59s"],
    [3_599_900, "1h 0m 0s"],
    [3_600_000, "1h 0m 0s"],
    [3_723_000, "1h 2m 3s"],
  ])("formats %dms as %s", (milliseconds, expected) => {
    expect(formatDuration(milliseconds)).toBe(expected);
  });
});
