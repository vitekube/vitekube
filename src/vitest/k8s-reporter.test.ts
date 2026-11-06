import { DefaultReporter } from "vitest/node";
import { describe, expect, it } from "vitest";

import { K8sReporter } from "./k8s-reporter.ts";

describe("K8sReporter", () => {
  it("overrides a method Vitest's reporter still has, so an upgrade that renames it fails here", () => {
    expect(typeof (DefaultReporter.prototype as unknown as { getDurationPrefix?: unknown }).getDurationPrefix).toBe(
      "function"
    );
  });

  it("formats a test's duration", () => {
    const reporter = new K8sReporter() as unknown as {
      getDurationPrefix: (task: { result?: { duration?: number } }) => string;
    };
    Object.assign(reporter, { ctx: { config: { slowTestThreshold: 300 } } });

    expect(reporter.getDurationPrefix({ result: { duration: 38_196 } })).toContain("38.2s");
    expect(reporter.getDurationPrefix({})).toBe("");
  });
});
