import type { V1Deployment, V1Job, V1Pod } from "@kubernetes/client-node";
import { describe, expect } from "vitest";

import {
  createKubernetesClient,
  JobFailedError,
  KubernetesApiError,
  WaitTimeoutError,
  waitFor,
} from "../src/core/index.ts";
import { test } from "../src/index.ts";
import { targetWithClosedEndpoint, targetWithoutPermissions } from "./helpers.ts";
import { job, pod, webDeployment, WEB_IMAGE } from "./workloads.ts";

const POD = { apiVersion: "v1", kind: "Pod" };
const JOB = { apiVersion: "batch/v1", kind: "Job" };

describe("reading resources", () => {
  test("get returns null for a confirmed NotFound, and list can be empty", async ({ k8s, namespace }) => {
    await expect(k8s.get({ ...POD, namespace, name: "absent" })).resolves.toBeNull();
    await expect(k8s.list({ ...POD, namespace })).resolves.toEqual([]);
  });

  test("Forbidden throws instead of reading as absent", async ({ k8s, namespace, scope }) => {
    const limited = createKubernetesClient(await targetWithoutPermissions(k8s, namespace, scope));

    const error = await limited.get({ ...POD, namespace, name: "absent" }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(KubernetesApiError);
    expect(error).toMatchObject({ code: 403, reason: "Forbidden" });
  });

  test("Forbidden ends a wait immediately", async ({ k8s, namespace, scope }) => {
    const limited = createKubernetesClient(await targetWithoutPermissions(k8s, namespace, scope));
    const startedAt = Date.now();

    await expect(limited.waitForJobCompletion({ namespace, name: "absent" }, { timeoutMs: 60_000 })).rejects.toThrow(
      "Forbidden"
    );
    await expect(limited.waitForNone({ ...POD, namespace }, { timeoutMs: 60_000 })).rejects.toThrow("Forbidden");
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  test("a closed endpoint throws instead of reading as absent", async ({ k8s, namespace, scope }) => {
    const unreachable = createKubernetesClient(await targetWithClosedEndpoint(k8s, scope));

    await expect(unreachable.get({ ...POD, namespace, name: "absent" })).rejects.toThrow("failed");
  });

  test("an unknown context is refused", ({ k8s }) => {
    expect(() =>
      createKubernetesClient({ kubeconfigPath: k8s.target.kubeconfigPath, context: "no-such-context" })
    ).toThrow("no-such-context");
  });

  test("a deleted resource becomes absent", async ({ k8s, namespace }) => {
    const ref = { ...POD, namespace, name: "gone" };
    await k8s.apply(namespace, pod("gone", WEB_IMAGE, ["sleep", "600"]));
    expect(await k8s.get(ref)).not.toBeNull();
    expect((await k8s.list({ ...POD, namespace })).map((item) => item.metadata?.name)).toEqual(["gone"]);

    await k8s.delete(ref);
    await k8s.delete(ref);

    const absent = await waitFor(
      () => k8s.get(ref),
      (value) => value === null,
      { timeoutMs: 60_000, describe: "pod removal" }
    );
    expect(absent).toBeNull();
  });

  test("waitForNone selects resources without waiting for unrelated ones", async ({ k8s, namespace }) => {
    const resource = { apiVersion: "v1", kind: "ConfigMap", namespace };
    for (const name of ["selected", "unrelated"]) {
      await k8s.create({
        ...resource,
        metadata: { name, namespace, labels: { group: name } },
      });
    }
    await k8s.delete({ ...resource, name: "selected" });

    await k8s.waitForNone(resource, { labelSelector: "group=selected", timeoutMs: 30_000 });

    expect(await k8s.get({ ...resource, name: "unrelated" })).not.toBeNull();
  });

  test("waitForNone includes terminating resources until deletion finishes", async ({
    k8s,
    fileK8s,
    namespace,
    scope,
  }) => {
    const resource = { apiVersion: "v1", kind: "ConfigMap", namespace };
    const ref = { ...resource, name: "held" };
    await k8s.create({
      ...resource,
      metadata: { name: "held", namespace, labels: { group: "held" }, finalizers: ["vitekube.dev/test-hold"] },
    });
    scope.defer(async () => {
      if (await fileK8s.get(ref)) {
        await fileK8s.patch(ref, { metadata: { finalizers: [] } });
      }
    });
    await k8s.delete(ref);

    const error = await k8s
      .waitForNone(resource, { labelSelector: "group=held", timeoutMs: 0 })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WaitTimeoutError);
    expect(error).toMatchObject({ lastState: [{ name: "held", namespace, terminating: true }] });
    await k8s.patch(ref, { metadata: { finalizers: [] } });
    await k8s.waitForNone(resource, { labelSelector: "group=held", timeoutMs: 30_000 });
  });
});

describe("Jobs", () => {
  test("a successful Job reaches Complete", async ({ k8s, namespace }) => {
    await k8s.apply(namespace, job("ok", "echo done"));

    const done = await k8s.waitForJobCompletion({ namespace, name: "ok" }, { timeoutMs: 120_000 });

    expect(done).toHaveCondition("Complete");
    expect(done).not.toHaveCondition("Failed");
  });

  test("a Job that retries through a failed pod still completes", async ({ k8s, namespace }) => {
    // The first pod fails after leaving a file on the node, so the retry can succeed.
    const script = `if [ -f /shared/${namespace} ]; then exit 0; fi; touch /shared/${namespace}; exit 1`;
    const manifest = job(
      "retries",
      script,
      { backoffLimit: 2 },
      {
        volumes: [{ name: "shared", hostPath: { path: "/tmp/vitekube-e2e", type: "DirectoryOrCreate" } }],
        containers: [
          {
            name: "main",
            image: WEB_IMAGE,
            command: ["sh", "-c", script],
            volumeMounts: [{ name: "shared", mountPath: "/shared" }],
          },
        ],
      }
    );
    await k8s.apply(namespace, manifest);

    const done = await k8s.waitForJobCompletion({ namespace, name: "retries" }, { timeoutMs: 120_000 });

    expect(done.status?.failed).toBe(1);
    expect(done).toHaveCondition("Complete");
  });

  test("a Job that fails for good ends the wait with its reason", async ({ k8s, namespace }) => {
    await k8s.apply(namespace, job("bad", "exit 3"));

    const error = await k8s
      .waitForJobCompletion({ namespace, name: "bad" }, { timeoutMs: 120_000 })
      .catch((caught: unknown) => caught as Error);

    expect(error).toBeInstanceOf(JobFailedError);
    expect((error as Error).message).toContain("BackoffLimitExceeded");
    expect(await k8s.get<V1Job>({ ...JOB, namespace, name: "bad" })).toHaveCondition("Failed");
  });

  test("a timeout reports the last state", async ({ k8s, namespace }) => {
    await k8s.apply(namespace, job("slow", "sleep 600"));

    const error = await k8s
      .waitForJobCompletion({ namespace, name: "slow" }, { timeoutMs: 1_500, intervalMs: 200 })
      .catch((caught: unknown) => caught as WaitTimeoutError);

    expect(error).toBeInstanceOf(WaitTimeoutError);
    expect((error as WaitTimeoutError).lastState).toHaveProperty("conditions");
  });

  test("waiting for a Job that does not exist fails at once", async ({ k8s, namespace }) => {
    const startedAt = Date.now();

    await expect(k8s.waitForJobCompletion({ namespace, name: "absent" }, { timeoutMs: 60_000 })).rejects.toThrow(
      "does not exist"
    );
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });
});

describe("Pods", () => {
  test("a pod that cannot pull its image stays waiting, and the timeout says why", async ({ k8s, namespace }) => {
    await k8s.apply(
      namespace,
      pod("stuck", "registry.invalid/no-such-image:1", ["true"], [{ name: "SECRET_TOKEN", value: "e2e-secret-marker" }])
    );
    const ref = { namespace, name: "stuck" };

    const waiting = await waitFor(
      () => k8s.get<V1Pod>({ ...POD, ...ref }),
      (value) =>
        value?.status?.containerStatuses?.[0]?.state?.waiting?.reason !== "ContainerCreating" &&
        Boolean(value?.status?.containerStatuses?.[0]?.state?.waiting),
      { timeoutMs: 90_000, describe: "the pull to fail" }
    );
    expect(waiting).toHaveContainerState("main", "waiting");
    expect(waiting).not.toBePodReady();

    const error = await k8s
      .waitForPodReady(ref, { timeoutMs: 500, intervalMs: 100 })
      .catch((caught: unknown) => caught as Error);
    expect(error).toBeInstanceOf(WaitTimeoutError);
    expect((error as Error).message).toMatch(/ErrImagePull|ImagePullBackOff/);
    expect((error as Error).message).not.toContain("e2e-secret-marker");
  });

  test("a matcher failure does not print the pod's environment", async ({ k8s, namespace }) => {
    await k8s.apply(
      namespace,
      pod("env", WEB_IMAGE, ["sleep", "600"], [{ name: "SECRET_TOKEN", value: "e2e-secret-marker" }])
    );
    const running = await k8s.waitForPodReady({ namespace, name: "env" }, { timeoutMs: 120_000 });

    let message = "";
    try {
      expect(running).toHaveContainerState("main", "terminated");
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("running");
    expect(message).not.toContain("e2e-secret-marker");
  });
});

describe("Deployments", () => {
  test("a rollout waits for the current generation", async ({ k8s, namespace }) => {
    await k8s.apply(namespace, webDeployment("web"));
    const first = await k8s.waitForRollout({ namespace, name: "web" }, { timeoutMs: 120_000 });
    expect(first).toHaveCondition("Available");

    await k8s.patch({ apiVersion: "apps/v1", kind: "Deployment", namespace, name: "web" }, { spec: { replicas: 2 } });
    const second = await k8s.waitForRollout({ namespace, name: "web" }, { timeoutMs: 120_000 });

    expect(second.metadata?.generation).toBeGreaterThan(first.metadata?.generation ?? 0);
    expect(second.status?.availableReplicas).toBe(2);
  });

  test("namespaces are labeled and named after the test", async ({ k8s, namespace }) => {
    const found = await k8s.get({ apiVersion: "v1", kind: "Namespace", name: namespace });

    expect(namespace).toMatch(/^vk8s-namespaces-are-labeled/);
    expect(found?.metadata?.labels).toHaveProperty(["vitekube.dev/ephemeral"], "true");
    await expect(k8s.list<V1Deployment>({ apiVersion: "apps/v1", kind: "Deployment", namespace })).resolves.toEqual([]);
  });
});
