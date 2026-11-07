import type { V1Pod } from "@kubernetes/client-node";
import { describe, expect } from "vitest";

import { waitFor } from "../src/core/index.ts";
import { test } from "../src/index.ts";
import { pod, versionedWebDeployment, webService, WEB_IMAGE } from "./workloads.ts";

describe("memory limits", () => {
  test("a pod over its memory limit gets OOMKilled", async ({ k8s, namespace }) => {
    await k8s.applyFile(namespace, "fixtures/memory-hog.yaml");

    const killed = await waitFor(
      () => k8s.get<V1Pod>({ apiVersion: "v1", kind: "Pod", namespace, name: "hog" }),
      (found) => found?.status?.containerStatuses?.[0]?.state?.terminated?.reason === "OOMKilled",
      { timeoutMs: 120_000, describe: "the kernel to kill the container" }
    );

    expect(killed).toHaveContainerState("main", "terminated");
    expect(killed?.status?.containerStatuses?.[0]?.state?.terminated?.exitCode).toBe(137);
  });
});

describe("rolling updates", () => {
  // Waits for the first answer, because a new Service's name takes a moment to resolve. After that, every failure counts.
  const requestLoop = `
    until wget -q -T 2 -O- http://web 2>/dev/null; do sleep 1; done
    while true; do wget -q -T 2 -O- http://web || echo FAILED; done
  `;

  test("a deploy drops no requests", async ({ k8s, namespace }) => {
    await k8s.apply(namespace, versionedWebDeployment("web", "v1"));
    await k8s.apply(namespace, webService("web"));
    await k8s.waitForRollout({ namespace, name: "web" }, { timeoutMs: 120_000 });

    // Inside the cluster, because a port-forward sticks to one pod and ends when that pod is replaced.
    await k8s.apply(namespace, pod("client", WEB_IMAGE, ["sh", "-c", requestLoop]));
    await k8s.waitForPodReady({ namespace, name: "client" }, { timeoutMs: 120_000 });
    const clientLogs = () => k8s.logs({ namespace, name: "client" });
    await waitFor(clientLogs, (logs) => logs.includes("v1"), { timeoutMs: 120_000, describe: "the first answer" });

    await k8s.apply(namespace, versionedWebDeployment("web", "v2"));
    await k8s.waitForRollout({ namespace, name: "web" }, { timeoutMs: 120_000 });
    // A rollout can finish while old pods are still shutting down, and that is when requests get dropped.
    await waitFor(
      () => k8s.list<V1Pod>({ apiVersion: "v1", kind: "Pod", namespace }, { labelSelector: "app=web" }),
      (pods) => pods.length === 2,
      { timeoutMs: 60_000, describe: "the old pods to exit" }
    );

    const answers = (await clientLogs()).trim().split("\n");
    expect(answers.filter((answer) => answer !== "v1" && answer !== "v2")).toEqual([]);
    expect(answers).toContain("v1");
    expect(answers.at(-1)).toBe("v2");
  });
});
