import { describe, expect, test } from "vitest";

import { ephemeralNamespaceName } from "./namespace.ts";

const validName = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

describe("ephemeralNamespaceName", () => {
  test.each([
    "a Job runs to completion",
    "  Üñí©ødé / test!! ",
    "!!!",
    "",
    `${"long ".repeat(40)}name`,
    "ends with separator at the limit".padEnd(53, "-") + "x".repeat(20),
  ])("produces a valid name for %j", (testName) => {
    const name = ephemeralNamespaceName(testName);

    expect(name).toMatch(validName);
    expect(name.length).toBeLessThanOrEqual(63);
  });

  test("shows the test it belongs to", () => {
    expect(ephemeralNamespaceName("a Job runs")).toMatch(/^vk8s-a-job-runs-[a-f0-9]{6}$/);
  });

  test("is unique per call", () => {
    expect(ephemeralNamespaceName("same")).not.toBe(ephemeralNamespaceName("same"));
  });
});
