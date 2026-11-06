import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { V1Deployment } from "@kubernetes/client-node";
import { describe, expect, inject } from "vitest";

import {
  CommandCanceledError,
  CommandFailedError,
  createKubernetesClient,
  runChecked,
  type KubernetesClient,
} from "../src/core/index.ts";
import { test } from "../src/index.ts";
import { targetWithClosedEndpoint } from "./helpers.ts";
import { pod, webDeployment, webService, WEB_IMAGE } from "./workloads.ts";

const execFileAsync = promisify(execFile);

const isPortForwardRunning = async (port: number): Promise<boolean> => {
  const { stdout } = await execFileAsync("ps", ["-A", "-o", "command="]);
  return stdout.split("\n").some((line) => line.includes("port-forward") && line.includes(`${port}:`));
};

const startWeb = async (k8s: KubernetesClient, namespace: string, name = "web") => {
  await k8s.apply(namespace, webDeployment(name));
  await k8s.apply(namespace, webService(name));
  await k8s.waitForRollout({ namespace, name }, { timeoutMs: 120_000 });
};

const replicasOf = async (k8s: KubernetesClient, namespace: string, name: string) => {
  const found = await k8s.get<V1Deployment>({ apiVersion: "apps/v1", kind: "Deployment", namespace, name });
  return found?.spec?.replicas;
};

describe("port-forward", () => {
  test("a forward opened in global setup reaches tests", async () => {
    const response = await fetch(inject("sharedWebUrl"));

    expect(await response.text()).toBe("ok\n");
  });

  test("forwards are ready on first use, use separate ports, and stop when closed", async ({ k8s, namespace }) => {
    await startWeb(k8s, namespace);
    const options = { namespace, resource: "service/web", remotePort: 80 };
    const first = await k8s.portForward(options);
    const second = await k8s.portForward(options);

    expect(first.port).not.toBe(second.port);
    expect(await (await fetch(first.url)).text()).toBe("ok\n");
    expect(await (await fetch(second.url)).text()).toBe("ok\n");

    await first.close();
    await second.close();
    await first.close();

    expect(first.isRunning()).toBe(false);
    expect(await isPortForwardRunning(first.port)).toBe(false);
    await expect(fetch(first.url)).rejects.toThrow();
  });

  test("a forward to a missing target fails promptly", async ({ k8s, namespace }) => {
    const startedAt = Date.now();

    await expect(k8s.portForward({ namespace, resource: "service/absent", remotePort: 80 })).rejects.toThrow("absent");
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });

  test("await using closes a forward", async ({ k8s, namespace }) => {
    await startWeb(k8s, namespace);
    let port = 0;
    {
      await using forward = await k8s.portForward({ namespace, resource: "service/web", remotePort: 80 });
      port = forward.port;
    }

    expect(await isPortForwardRunning(port)).toBe(false);
  });
});

describe("logs and exec", () => {
  test("logs return what the container wrote", async ({ k8s, namespace }) => {
    await k8s.apply(namespace, pod("logger", WEB_IMAGE, ["sh", "-c", "echo line-one; echo line-two; sleep 600"]));
    await k8s.waitForPodReady({ namespace, name: "logger" }, { timeoutMs: 120_000 });

    await expect(k8s.logs({ namespace, name: "logger" }, { container: "main", tailLines: 1 })).resolves.toBe(
      "line-two\n"
    );
  });

  test("exec keeps the exit status and exact bytes", async ({ k8s, namespace }) => {
    await k8s.apply(namespace, pod("shell", WEB_IMAGE, ["sleep", "600"]));
    await k8s.waitForPodReady({ namespace, name: "shell" }, { timeoutMs: 120_000 });
    const ref = { namespace, name: "shell" };
    const bytes = Buffer.from([0xff, 0x00, 0x0a, 0x20, 0x0a]);

    const echoed = await k8s.exec(ref, ["cat"], { input: bytes });
    const failed = await k8s.exec(ref, ["sh", "-c", "exit 4"]);

    expect([...echoed.stdoutBytes]).toEqual([...bytes]);
    expect(failed.status).toBe(4);
  });

  test("logs of a missing pod throw", async ({ k8s, namespace }) => {
    await expect(k8s.logs({ namespace, name: "absent" })).rejects.toThrow(CommandFailedError);
  });
});

describe("temporary scaling", () => {
  test("replicas are restored after a deliberate exception", async ({ k8s, namespace }) => {
    await startWeb(k8s, namespace);

    await expect(
      (async () => {
        await using paused = await k8s.scaleTemporarily({ namespace, name: "web" }, 0);
        expect(paused.originalReplicas).toBe(1);
        expect(await replicasOf(k8s, namespace, "web")).toBe(0);
        throw new Error("deliberate");
      })()
    ).rejects.toThrow("deliberate");

    expect(await replicasOf(k8s, namespace, "web")).toBe(1);
  });

  test("a test can resume early, and restoring twice is safe", async ({ k8s, namespace }) => {
    await startWeb(k8s, namespace);
    await using paused = await k8s.scaleTemporarily({ namespace, name: "web" }, 0);

    await paused.restore();
    await paused.restore();

    const deployment = await k8s.waitForRollout({ namespace, name: "web" }, { timeoutMs: 60_000 });
    expect(deployment.status?.availableReplicas).toBe(1);
  });

  test("a failed restoration reports the damage", async ({ k8s, namespace }) => {
    await startWeb(k8s, namespace);
    const damage: string[] = [];
    const client = createKubernetesClient(k8s.target, {
      onEnvironmentDamaged: async (reason) => {
        damage.push(reason);
      },
    });
    const paused = await client.scaleTemporarily({ namespace, name: "web" }, 0);
    await k8s.delete({ apiVersion: "apps/v1", kind: "Deployment", namespace, name: "web" });

    await expect(paused.restore()).rejects.toThrow("could not restore");

    expect(damage).toHaveLength(1);
    expect(damage[0]).toContain("web");
  });
});

describe("Helm observer", () => {
  const chart = resolve(import.meta.dirname, "fixtures/chart");

  test("a missing release is null", async ({ k8s, namespace }) => {
    await expect(k8s.helm.status({ namespace, name: "absent" })).resolves.toBeNull();
  });

  test("an installed release reports status without its values", async ({ k8s, namespace }) => {
    const { kubeconfigPath, context } = k8s.target;
    await runChecked(
      "helm",
      [
        "install",
        "fixture",
        chart,
        "--namespace",
        namespace,
        "--kubeconfig",
        kubeconfigPath,
        "--kube-context",
        context,
        "--set",
        "value=e2e-secret-marker",
        "--wait",
      ],
      { timeoutMs: 120_000, private: true }
    );

    const release = await k8s.helm.status({ namespace, name: "fixture" });

    expect(release).toEqual({ name: "fixture", namespace, status: "deployed", revision: 1 });
    expect(JSON.stringify(release)).not.toContain("e2e-secret-marker");
  });

  test("an unreachable cluster throws instead of reading as absent", async ({ k8s, namespace, scope }) => {
    const unreachable = createKubernetesClient(await targetWithClosedEndpoint(k8s, scope));

    await expect(unreachable.helm.status({ namespace, name: "absent" })).rejects.toThrow("Could not read Helm release");
  });
});

describe("cancellation", () => {
  test("canceling a test's signal ends its work", async ({ k8s, namespace }) => {
    await k8s.apply(namespace, pod("slow", WEB_IMAGE, ["sleep", "600"]));
    await k8s.waitForPodReady({ namespace, name: "slow" }, { timeoutMs: 120_000 });
    const controller = new AbortController();
    const canceled = createKubernetesClient(k8s.target, { signal: controller.signal });
    const startedAt = Date.now();
    setTimeout(() => controller.abort(), 100);

    await expect(canceled.exec({ namespace, name: "slow" }, ["sleep", "60"], { timeoutMs: 60_000 })).rejects.toThrow(
      CommandCanceledError
    );
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });
});
