import { ApiException, KubeConfig, KubernetesObjectApi, type V1Deployment } from "@kubernetes/client-node";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createKubernetesClient, KubernetesApiError } from "./kubernetes.ts";
import { WaitTimeoutError } from "./wait.ts";

const target = { kubeconfigPath: "/unused/kubeconfig", context: "test" };
const pods = { apiVersion: "v1", kind: "Pod", namespace: "workers" };
const worker = { namespace: "workers", name: "worker" };
const deployment = (): V1Deployment => ({
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: { name: "worker", namespace: "workers", generation: 1 },
  spec: { replicas: 2, selector: { matchLabels: { app: "worker" } }, template: {} },
  status: { observedGeneration: 1, replicas: 2, updatedReplicas: 2, availableReplicas: 2 },
});

const api = {
  read: vi.fn(),
  list: vi.fn(),
  patch: vi.fn(),
};

beforeEach(() => {
  api.read.mockReset().mockResolvedValue(deployment());
  api.list.mockReset().mockResolvedValue({ items: [] });
  api.patch.mockReset().mockResolvedValue({});
  vi.spyOn(KubeConfig.prototype, "loadFromFile").mockImplementation(() => {});
  vi.spyOn(KubeConfig.prototype, "getContextObject").mockReturnValue({
    name: "test",
    cluster: "test",
    user: "test",
  });
  vi.spyOn(KubeConfig.prototype, "setCurrentContext").mockImplementation(() => {});
  vi.spyOn(KubernetesObjectApi, "makeApiClient").mockReturnValue(api as unknown as KubernetesObjectApi);
});

afterEach(() => vi.restoreAllMocks());

describe("patch", () => {
  test("metadata changes preserve the resource identity used for the API request", async () => {
    await createKubernetesClient(target).patch(
      { apiVersion: "v1", kind: "Pod", namespace: "workers", name: "worker" },
      { metadata: { finalizers: [], annotations: { note: "updated" } } }
    );

    expect(api.patch.mock.calls[0]?.[0]).toEqual({
      apiVersion: "v1",
      kind: "Pod",
      metadata: { namespace: "workers", name: "worker", finalizers: [], annotations: { note: "updated" } },
    });
  });
});

describe("waitForNone", () => {
  test("passes the selector to each read and waits for an empty list", async () => {
    api.list.mockResolvedValueOnce({ items: [{ metadata: { name: "old" } }] });
    const client = createKubernetesClient(target);

    await client.waitForNone(pods, { labelSelector: "app=worker", timeoutMs: 100, intervalMs: 1 });

    expect(api.list).toHaveBeenCalledTimes(2);
    expect(api.list).toHaveBeenLastCalledWith(
      "v1",
      "Pod",
      "workers",
      undefined,
      undefined,
      undefined,
      undefined,
      "app=worker"
    );
  });

  test("terminating resources still count and only their identities appear in timeouts", async () => {
    api.list.mockResolvedValue({
      items: [
        {
          metadata: { name: "old", namespace: "workers", deletionTimestamp: new Date() },
          spec: { secret: "never-print-this" },
        },
      ],
    });

    const error = await createKubernetesClient(target)
      .waitForNone(pods, { labelSelector: "app=worker", timeoutMs: 0 })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WaitTimeoutError);
    expect(error).toMatchObject({
      lastState: [{ name: "old", namespace: "workers", terminating: true }],
    });
    expect(String(error)).toContain("app=worker");
    expect(String(error)).not.toContain("never-print-this");
  });

  test.each([new ApiException(403, "denied", { reason: "Forbidden" }, {}), new Error("connection refused")])(
    "read failures never count as absence: %s",
    async (error) => {
      api.list.mockRejectedValue(error);

      await expect(createKubernetesClient(target).waitForNone(pods, { timeoutMs: 60_000 })).rejects.toThrow();
      expect(api.list).toHaveBeenCalledTimes(1);
    }
  );

  test("an already canceled client does not read or pass an empty list", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      createKubernetesClient(target, { signal: controller.signal }).waitForNone(pods, { timeoutMs: 60_000 })
    ).rejects.toThrow();
    expect(api.list).not.toHaveBeenCalled();
  });

  test("direct API requests also reject before reading an already canceled client", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      createKubernetesClient(target, { signal: controller.signal }).get({ ...pods, name: "worker" })
    ).rejects.toThrow("canceled");
    expect(api.read).not.toHaveBeenCalled();
  });
});

describe("temporary scaling", () => {
  test("the default remains patch-only, and restoration is idempotent", async () => {
    const paused = await createKubernetesClient(target).scaleTemporarily(worker, 0);

    expect(paused.originalReplicas).toBe(2);
    expect(api.list).not.toHaveBeenCalled();
    expect(api.patch).toHaveBeenCalledTimes(1);
    await paused.restore();
    await paused.restore();
    expect(api.patch).toHaveBeenCalledTimes(2);
    expect(api.patch.mock.calls[1]?.[0]).toMatchObject({ spec: { replicas: 2 } });
  });

  test("pods-gone uses the full Deployment selector", async () => {
    const found = deployment();
    found.spec!.selector.matchExpressions = [
      { key: "tier", operator: "In", values: ["queue", "background"] },
      { key: "track", operator: "NotIn", values: ["canary"] },
      { key: "managed", operator: "Exists" },
      { key: "disabled", operator: "DoesNotExist" },
    ];
    api.read.mockResolvedValue(found);
    const paused = await createKubernetesClient(target).scaleTemporarily(worker, 0, {
      waitFor: "pods-gone",
    });

    expect(api.list.mock.calls[0]?.[7]).toBe(
      "app=worker,tier in (queue,background),track notin (canary),managed,!disabled"
    );
    await paused.restore();
  });

  test("a failed wait restores before throwing the original error", async () => {
    api.list.mockResolvedValue({ items: [{ metadata: { name: "terminating" } }] });

    await expect(
      createKubernetesClient(target).scaleTemporarily(worker, 0, { waitFor: "pods-gone", timeoutMs: 0 })
    ).rejects.toThrow(WaitTimeoutError);
    expect(api.patch.mock.calls.map(([value]) => value.spec.replicas)).toEqual([0, 2]);
  });

  test("cancellation during acquisition still restores with an uncanceled client", async () => {
    const controller = new AbortController();
    api.list.mockImplementation(async () => {
      controller.abort();
      return { items: [{ metadata: { name: "terminating" } }] };
    });

    await expect(
      createKubernetesClient(target, { signal: controller.signal }).scaleTemporarily(worker, 0, {
        waitFor: "pods-gone",
      })
    ).rejects.toThrow();
    expect(api.patch.mock.calls.map(([value]) => value.spec.replicas)).toEqual([0, 2]);
  });

  test("a failed rollback reports damage without hiding the acquisition failure", async () => {
    api.list.mockRejectedValue(new ApiException(403, "denied", { reason: "Forbidden" }, {}));
    api.patch.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("restore unavailable"));
    const onEnvironmentDamaged = vi.fn().mockResolvedValue(undefined);

    await expect(
      createKubernetesClient(target, { onEnvironmentDamaged }).scaleTemporarily(worker, 0, {
        waitFor: "pods-gone",
      })
    ).rejects.toThrow(KubernetesApiError);
    expect(onEnvironmentDamaged).toHaveBeenCalledWith(expect.stringContaining("restore unavailable"));
  });

  test("rejects a nonzero pods-gone target before changing anything", async () => {
    await expect(createKubernetesClient(target).scaleTemporarily(worker, 1, { waitFor: "pods-gone" })).rejects.toThrow(
      "zero replicas"
    );
    expect(api.read).not.toHaveBeenCalled();
    expect(api.patch).not.toHaveBeenCalled();
  });

  test("rejects an empty selector before changing anything", async () => {
    const found = deployment();
    found.spec!.selector = {};
    api.read.mockResolvedValue(found);

    await expect(createKubernetesClient(target).scaleTemporarily(worker, 0, { waitFor: "pods-gone" })).rejects.toThrow(
      "nonempty selector"
    );
    expect(api.patch).not.toHaveBeenCalled();
  });
});
