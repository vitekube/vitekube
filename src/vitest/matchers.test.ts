import type { V1Pod } from "@kubernetes/client-node";
import { describe, expect, test } from "vitest";

import { toBePodReady, toHaveCondition, toHaveContainerState } from "./matchers.ts";

const pod: V1Pod = {
  kind: "Pod",
  metadata: { name: "worker" },
  spec: { containers: [{ name: "c", env: [{ name: "TOKEN", value: "hunter2" }] }] },
  status: {
    phase: "Pending",
    conditions: [{ type: "Ready", status: "False", reason: "ContainersNotReady" }],
    containerStatuses: [
      {
        name: "c",
        ready: false,
        restartCount: 0,
        image: "x",
        imageID: "",
        state: { waiting: { reason: "ErrImagePull" } },
      },
    ],
  },
};

describe("matchers", () => {
  test("toHaveCondition compares type and status", () => {
    expect(toHaveCondition(pod, "Ready", "False").pass).toBe(true);
    expect(toHaveCondition(pod, "Ready").pass).toBe(false);
    expect(toHaveCondition(pod, "Other").pass).toBe(false);
  });

  test("toBePodReady", () => {
    expect(toBePodReady(pod).pass).toBe(false);
  });

  test("toHaveContainerState", () => {
    expect(toHaveContainerState(pod, "c", "waiting").pass).toBe(true);
    expect(toHaveContainerState(pod, "c", "running").pass).toBe(false);
    expect(toHaveContainerState(pod, "missing", "waiting").pass).toBe(false);
  });

  test("failure messages explain the state without printing the spec", () => {
    const messages = [
      toHaveCondition(pod, "Ready").message(),
      toBePodReady(pod).message(),
      toHaveContainerState(pod, "c", "running").message(),
    ];

    expect(messages[0]).toContain("ContainersNotReady");
    expect(messages[2]).toContain("ErrImagePull");
    expect(messages.join()).not.toContain("hunter2");
  });
});
