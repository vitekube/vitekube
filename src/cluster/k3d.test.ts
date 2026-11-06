import { describe, expect, test } from "vitest";

import { parseLifecycleLabels } from "./k3d.ts";

describe("parseLifecycleLabels", () => {
  test("finds the label on any container", () => {
    expect(parseLifecycleLabels("\nreuse\n")).toBe("reuse");
    expect(parseLifecycleLabels("fresh\n\n")).toBe("fresh");
  });

  test.each(["", "\n\n", "something-else\n"])("treats %j as a cluster this package did not create", (output) => {
    expect(parseLifecycleLabels(output)).toBeUndefined();
  });
});
