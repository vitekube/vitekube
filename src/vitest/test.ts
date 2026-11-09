import { expect, inject, test as base } from "vitest";

import { createClusterStateStore } from "../cluster/state.ts";
import { createKubernetesClient, type KubernetesTarget } from "../core/kubernetes.ts";
import { createScope } from "../core/scope.ts";
import { createEvidence } from "./evidence.ts";
import { toBePodReady, toHaveCondition, toHaveContainerState } from "./matchers.ts";
import { EPHEMERAL_NAMESPACE_LABEL, ephemeralNamespaceName } from "./namespace.ts";
import "./matcher-types.ts";
import "./provided.ts";

expect.extend({ toBePodReady, toHaveCondition, toHaveContainerState });

/** Reports a forgotten setup clearly, instead of a TypeError from the Kubernetes client. */
const clusterTarget = (): KubernetesTarget => {
  const target = inject("vitekubeTarget") as KubernetesTarget | undefined;
  if (!target) {
    throw new Error(
      "No cluster: add a file that exports defineK8sGlobalSetup() to `globalSetup` in your Vitest config."
    );
  }
  return target;
};

const stateStore = () => createClusterStateStore(createKubernetesClient(clusterTarget()));

export const test = base
  // Stops a run whose shared state could not be restored, instead of letting later tests fail misleadingly.
  .extend("environmentGuard", { auto: true }, async () => {
    const state = await stateStore().read();
    if (state?.unusable) {
      throw new Error(`The test cluster is marked unusable: ${state.unusable}`);
    }
  })
  // For file-scoped fixtures, such as pausing a controller for a whole file. Not tied to any one test's signal.
  // oxlint-disable-next-line no-empty-pattern -- Vitest requires object destructuring here.
  .extend("fileK8s", { scope: "file" }, ({}) =>
    createKubernetesClient(clusterTarget(), {
      rootDir: inject("vitekubeRoot"),
      onEnvironmentDamaged: (reason) => stateStore().markUnusable(reason),
    })
  )
  .extend("k8s", ({ signal }) =>
    createKubernetesClient(clusterTarget(), {
      rootDir: inject("vitekubeRoot"),
      onEnvironmentDamaged: (reason) => stateStore().markUnusable(reason),
      signal,
    })
  )
  // oxlint-disable-next-line no-empty-pattern -- Vitest requires object destructuring here.
  .extend("scope", async ({}, { onCleanup }) => {
    const scope = createScope();
    onCleanup(() => scope.dispose());
    return scope;
  })
  // Collected in an afterEach hook, which Vitest runs before any fixture is torn down.
  .extend("evidence", ({ fileK8s }) => createEvidence(fileK8s))
  // For a fixture that changed shared cluster state and could not put it back. Later tests then stop with this reason.
  .extend("markClusterUnusable", () => (reason: string) => stateStore().markUnusable(reason))
  .extend("namespace", async ({ task, evidence, fileK8s }, { onCleanup }) => {
    // The file client is not canceled on test timeout, so evidence and cleanup still work.
    const client = fileK8s;
    const name = ephemeralNamespaceName(task.name);
    await client.create({
      apiVersion: "v1",
      kind: "Namespace",
      metadata: { name, labels: { [EPHEMERAL_NAMESPACE_LABEL]: "true" } },
    });
    evidence.watchResources({ namespace: name });
    onCleanup(async () => {
      if (task.result?.state === "fail" && process.env.VITEKUBE_KEEP_ON_FAILURE === "1") {
        const { kubeconfigPath, context } = client.target;
        console.error(
          `[vitekube] kept namespace ${name} because the test failed. The next run removes it. Inspect it with:\n` +
            `  kubectl --kubeconfig ${kubeconfigPath} --context ${context} --namespace ${name} get all`
        );
        return;
      }
      await client.delete({ apiVersion: "v1", kind: "Namespace", name });
    });
    return name;
  });

test.afterEach(async ({ task, evidence }) => {
  if (task.result?.state === "fail") {
    console.error(await evidence.capture());
  }
});
