import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KubeConfig } from "@kubernetes/client-node";

import { runChecked, type KubernetesClient, type KubernetesTarget, type Scope } from "../src/core/index.ts";

const writeTarget = async (config: KubeConfig, scope: Scope): Promise<KubernetesTarget> => {
  const directory = await mkdtemp(join(tmpdir(), "vitekube-e2e-"));
  scope.defer(() => rm(directory, { recursive: true, force: true }), { label: "temporary kubeconfig" });
  const kubeconfigPath = join(directory, "kubeconfig.yaml");
  await writeFile(kubeconfigPath, config.exportConfig(), { mode: 0o600 });
  return { kubeconfigPath, context: config.getCurrentContext() };
};

const buildConfig = (base: KubernetesTarget, overrides: { user?: { token: string }; server?: string }): KubeConfig => {
  const source = new KubeConfig();
  source.loadFromFile(base.kubeconfigPath);
  source.setCurrentContext(base.context);
  const cluster = source.getCurrentCluster();
  const user = source.getCurrentUser();
  if (!cluster || !user) {
    throw new Error("Kubeconfig has no current cluster or user");
  }

  const config = new KubeConfig();
  config.loadFromOptions({
    clusters: [{ ...cluster, server: overrides.server ?? cluster.server }],
    users: [overrides.user ? { name: "limited", token: overrides.user.token } : user],
    contexts: [{ name: "limited", cluster: cluster.name, user: overrides.user ? "limited" : user.name }],
    currentContext: "limited",
  });
  return config;
};

/** A target whose credentials are a ServiceAccount with no permissions at all. */
export const targetWithoutPermissions = async (
  k8s: KubernetesClient,
  namespace: string,
  scope: Scope
): Promise<KubernetesTarget> => {
  await k8s.create({ apiVersion: "v1", kind: "ServiceAccount", metadata: { name: "limited", namespace } });
  const { stdout: token } = await runChecked(
    "kubectl",
    [
      "--kubeconfig",
      k8s.target.kubeconfigPath,
      "--context",
      k8s.target.context,
      "create",
      "token",
      "limited",
      "--namespace",
      namespace,
    ],
    { timeoutMs: 30_000 }
  );
  return writeTarget(buildConfig(k8s.target, { user: { token: token.trim() } }), scope);
};

/** A target whose server has nothing listening. */
export const targetWithClosedEndpoint = (k8s: KubernetesClient, scope: Scope): Promise<KubernetesTarget> =>
  writeTarget(buildConfig(k8s.target, { server: "https://127.0.0.1:1" }), scope);
