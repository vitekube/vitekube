import { describe, expect, test } from "vitest";

import { parseLifecycleLabels, userNamespaceK3sArgs } from "./k3d.ts";

describe("parseLifecycleLabels", () => {
  test("finds the label on any container", () => {
    expect(parseLifecycleLabels("\nreuse\n")).toBe("reuse");
    expect(parseLifecycleLabels("fresh\n\n")).toBe("fresh");
  });

  test.each(["", "\n\n", "something-else\n"])("treats %j as a cluster this package did not create", (output) => {
    expect(parseLifecycleLabels(output)).toBeUndefined();
  });
});

describe("userNamespaceK3sArgs", () => {
  const rootless = '["name=seccomp,profile=builtin","name=rootless","name=cgroupns"]\n';

  test("lets the kubelet run in a user namespace under rootless Docker", () => {
    expect(userNamespaceK3sArgs(rootless, [])).toEqual([
      "--kubelet-arg=feature-gates=KubeletInUserNamespace=true@server:*;agent:*",
    ]);
  });

  test.each(['["name=seccomp,profile=builtin","name=cgroupns"]', "null", "not json", ""])(
    "adds nothing for %j",
    (output) => {
      expect(userNamespaceK3sArgs(output, [])).toEqual([]);
    }
  );

  test("leaves a gate the caller set alone", () => {
    expect(
      userNamespaceK3sArgs(rootless, ["--kubelet-arg=feature-gates=KubeletInUserNamespace=false@server:*"])
    ).toEqual([]);
  });
});
