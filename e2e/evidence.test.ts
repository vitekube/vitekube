import { randomUUID } from "node:crypto";
import { expect } from "vitest";

import { createKubernetesClient } from "../src/core/index.ts";
import { test } from "../src/index.ts";
import { pod, WEB_IMAGE } from "./workloads.ts";

test("shared-namespace evidence selects Pods and remains usable after cancellation", async ({
  k8s,
  fileK8s,
  scope,
  evidence,
}) => {
  // Do not request the namespace fixture: this exercises explicit evidence registration.
  const namespace = `evidence-${randomUUID().slice(0, 8)}`;
  await k8s.create({ apiVersion: "v1", kind: "Namespace", metadata: { name: namespace } });
  scope.defer(() => fileK8s.delete({ apiVersion: "v1", kind: "Namespace", name: namespace }));
  evidence.watchResources({ namespace, labelSelector: "app=selected", tailLines: 10 });
  evidence.markSensitive("evidence-secret-marker");
  for (const name of ["selected", "unrelated"]) {
    const manifest = pod(name, WEB_IMAGE, ["sh", "-c", `echo ${name}-output-evidence-secret-marker; sleep 600`]);
    await k8s.apply(namespace, {
      ...manifest,
      metadata: { ...manifest.metadata, labels: { app: name } },
    });
    await k8s.waitForPodReady({ namespace, name }, { timeoutMs: 120_000 });
  }

  const controller = new AbortController();
  const canceled = createKubernetesClient(k8s.target, { signal: controller.signal });
  controller.abort();
  await expect(canceled.logs({ namespace, name: "selected" })).rejects.toThrow();
  const captured = await evidence.capture();

  expect(captured).toContain("selected/main");
  expect(captured).toContain("selected-output-***");
  expect(captured).not.toContain("evidence-secret-marker");
  expect(captured).not.toContain("unrelated");
  expect(captured).not.toContain("could not collect");
});
