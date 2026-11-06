import type { V1Deployment, V1Job, V1Pod } from "@kubernetes/client-node";
import { describe, expect, test } from "vitest";

import {
  containerStateOf,
  isJobComplete,
  isPodReady,
  isRolloutComplete,
  JobFailedError,
  PodTerminatedError,
  RolloutFailedError,
  summarizePod,
} from "./resources.ts";

const job = (status: V1Job["status"]): V1Job => ({ metadata: { name: "j", namespace: "n" }, status });

const condition = (type: string, status: string, reason?: string) => ({ type, status, reason });

describe("isJobComplete", () => {
  test("accepts Complete=True", () => {
    expect(isJobComplete(job({ conditions: [condition("Complete", "True")] }))).toBe(true);
  });

  test("failed pods are not terminal while the Job retries", () => {
    expect(isJobComplete(job({ failed: 3 }))).toBe(false);
  });

  test("a condition that is not True does not count", () => {
    expect(isJobComplete(job({ conditions: [condition("Complete", "False")] }))).toBe(false);
  });

  test("Failed=True is terminal and names the reason", () => {
    const failed = job({ conditions: [condition("Failed", "True", "BackoffLimitExceeded")] });

    expect(() => isJobComplete(failed)).toThrow(JobFailedError);
    expect(() => isJobComplete(failed)).toThrow("BackoffLimitExceeded");
  });
});

describe("isRolloutComplete", () => {
  const deployment = (overrides: { generation?: number; status?: V1Deployment["status"] }): V1Deployment => ({
    metadata: { name: "d", namespace: "n", generation: overrides.generation ?? 2 },
    spec: { replicas: 2, selector: {}, template: {} },
    status: overrides.status,
  });
  const settled = { observedGeneration: 2, replicas: 2, updatedReplicas: 2, availableReplicas: 2 };

  test("accepts a settled rollout of the current generation", () => {
    expect(isRolloutComplete(deployment({ status: settled }))).toBe(true);
  });

  test("a stale Available condition from an older generation does not pass", () => {
    const stale = {
      ...settled,
      observedGeneration: 1,
      conditions: [condition("Available", "True")],
    };

    expect(isRolloutComplete(deployment({ status: stale }))).toBe(false);
  });

  test("old replicas still running does not pass", () => {
    expect(isRolloutComplete(deployment({ status: { ...settled, replicas: 3 } }))).toBe(false);
  });

  test("an exceeded progress deadline is terminal", () => {
    const stuck = { ...settled, conditions: [condition("Progressing", "False", "ProgressDeadlineExceeded")] };

    expect(() => isRolloutComplete(deployment({ status: stuck }))).toThrow(RolloutFailedError);
  });
});

describe("pods", () => {
  const pod = (status: V1Pod["status"]): V1Pod => ({
    metadata: { name: "p", namespace: "n" },
    spec: { containers: [{ name: "c", env: [{ name: "TOKEN", value: "hunter2" }] }] },
    status,
  });

  test("Ready is separate from phase", () => {
    expect(isPodReady(pod({ phase: "Running", conditions: [condition("Ready", "False")] }))).toBe(false);
    expect(isPodReady(pod({ phase: "Running", conditions: [condition("Ready", "True")] }))).toBe(true);
  });

  test("a finished pod can never become ready", () => {
    expect(() => isPodReady(pod({ phase: "Failed" }))).toThrow(PodTerminatedError);
  });

  test("reads the state of a named container", () => {
    const waiting = pod({
      containerStatuses: [
        {
          name: "c",
          ready: false,
          restartCount: 0,
          image: "x",
          imageID: "",
          state: { waiting: { reason: "ImagePullBackOff" } },
        },
      ],
    });

    expect(containerStateOf(waiting, "c")).toEqual({ state: "waiting", reason: "ImagePullBackOff" });
    expect(containerStateOf(waiting, "other")).toBeUndefined();
  });

  test("summaries leave the spec out", () => {
    expect(JSON.stringify(summarizePod(pod({ phase: "Pending" })))).not.toContain("hunter2");
  });
});
