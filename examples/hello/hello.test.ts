import { test } from "vitekube";
import { expect } from "vitest";

const helloJob = {
  apiVersion: "batch/v1",
  kind: "Job",
  metadata: { name: "hello" },
  spec: {
    backoffLimit: 0,
    template: {
      spec: {
        restartPolicy: "Never",
        containers: [{ name: "hello", image: "busybox:1.37", command: ["sh", "-c", "echo hello"] }],
      },
    },
  },
};

test("a Job runs to completion", async ({ k8s, namespace }) => {
  await k8s.apply(namespace, helloJob);

  const job = await k8s.waitForJobCompletion({ namespace, name: "hello" }, { timeoutMs: 120_000 });

  expect(job).toHaveCondition("Complete");
});
