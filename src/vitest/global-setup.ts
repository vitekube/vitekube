import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { V1Namespace } from "@kubernetes/client-node";
import type { ProvidedContext } from "vitest";
import type { TestProject } from "vitest/node";

import { createK3dProvider, type ClusterProvider } from "../cluster/k3d.ts";
import { decideExistingCluster, isLockLive, isProcessAlive, type RunLock } from "../cluster/lock.ts";
import { createClusterStateStore, type ClusterState, type ClusterStateStore } from "../cluster/state.ts";
import { formatDuration } from "../core/duration.ts";
import { createKubernetesClient, type KubernetesClient, type KubernetesTarget } from "../core/kubernetes.ts";
import { killOwnedChildren } from "../core/process.ts";
import { createScope, type Scope } from "../core/scope.ts";
import { prepareEnvironment, type EnvironmentSpec } from "./environment.ts";
import { EPHEMERAL_NAMESPACE_LABEL } from "./namespace.ts";
import "./provided.ts";

export type ManagedClusterOptions = {
  provider: "k3d";
  /** The VITEKUBE_CLUSTER environment variable overrides this, for example to use one cluster per worktree. */
  name: string;
  agents?: number;
  /** In k3d's `ARG@NODEFILTER` form, such as `--disable=traefik@server:0`. Applied only when creating a cluster. */
  k3sArgs?: readonly string[];
  /** Keep the cluster between runs and reuse it. Otherwise each run gets a new cluster and deletes it afterward. */
  reuse?: boolean;
};

export type AttachedClusterOptions = {
  provider: "attached";
  kubeconfigPath: string;
  context: string;
  /**
   * A cluster without the vitekube marker is refused, because tests may be destructive. To adopt one, set this
   * to the exact name in `context`. That confirms it is a disposable test cluster, and writes the marker to it.
   */
  allowUnmarkedContext?: string;
};

export type K8sSetupContext = {
  k8s: KubernetesClient;
  target: KubernetesTarget;
  /** Disposed at the end of the run, for long-lived resources such as port-forwards. */
  scope: Scope;
  /** Passes a JSON-serializable value to tests, read there with Vitest's `inject`. */
  // oxlint-disable-next-line typescript/no-redundant-type-constituents -- matches Vitest's own `provide`.
  provide: <K extends keyof ProvidedContext & string>(key: K, value: ProvidedContext[K]) => void;
};

export type K8sGlobalSetupOptions = {
  cluster: ManagedClusterOptions | AttachedClusterOptions;
  /** What the cluster contains: images and ordered stages. Reruns do only the work whose inputs changed. */
  environment?: EnvironmentSpec;
  /** Runs on every run, after the environment is ready. For per-run resources such as port-forwards. */
  setup?: (context: K8sSetupContext) => Promise<void>;
  /** How long to wait for another run on the same cluster. Defaults to failing immediately. */
  lockWaitMs?: number;
};

const LOCK_TTL_MS = 60_000;
const HEARTBEAT_MS = 15_000;
const LOCK_POLL_MS = 2_000;
const MARKER = "vitekube";

const log = (message: string): void => console.log(`[vitekube] ${message}`);

/** `vitest list` runs global setup even though it only collects tests, and collecting needs no cluster. */
const isListCommand = (): boolean => process.argv.slice(2)[0] === "list";

const lockEnvironment = () => ({ now: Date.now(), hostname: hostname(), isProcessAlive });

const lockIsLive = (lock: RunLock | undefined): boolean => isLockLive(lock, lockEnvironment());

const describeLock = (lock: RunLock | undefined): string =>
  lock ? `process ${lock.pid} on ${lock.hostname}` : "another run";

/** Deterministic per cluster, so a later run can find and clean up after a killed one. */
const privateDirectory = (name: string): string => join(tmpdir(), "vitekube", name);

const readStateIfReachable = async (store: ClusterStateStore): Promise<ClusterState | null> => {
  try {
    return await store.read();
  } catch {
    return null;
  }
};

type Prepared = {
  target: KubernetesTarget;
  importImages?: (references: readonly string[]) => Promise<void>;
  deleteAtEnd: { provider: ClusterProvider; name: string; directory: string } | undefined;
};

type RunControl = {
  /** Set once this run has a cluster that it alone is responsible for deleting. */
  onOwnedCluster: (owned: NonNullable<Prepared["deleteAtEnd"]>) => void;
};

const writeKubeconfig = async (provider: ClusterProvider, name: string, path: string): Promise<KubernetesTarget> => {
  const { yaml, context } = await provider.kubeconfig(name);
  await writeFile(path, yaml, { mode: 0o600 });
  return { kubeconfigPath: path, context };
};

const prepareManagedCluster = async (
  options: ManagedClusterOptions,
  lockWaitMs: number,
  control: RunControl
): Promise<Prepared> => {
  const name = process.env.VITEKUBE_CLUSTER?.trim() || options.name;
  const wantReuse = options.reuse ?? false;
  const lifecycle = wantReuse ? "reuse" : "fresh";
  const directory = privateDirectory(name);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const kubeconfigPath = join(directory, "kubeconfig.yaml");
  const provider = createK3dProvider(kubeconfigPath);
  const deadline = Date.now() + lockWaitMs;

  while (true) {
    const existing = await provider.find(name);
    if (!existing) {
      break;
    }

    let state: ClusterState | null = null;
    let target: KubernetesTarget | undefined;
    if (existing.lifecycle) {
      target = await writeKubeconfig(provider, name, kubeconfigPath);
      state = await readStateIfReachable(createClusterStateStore(createKubernetesClient(target)));
    }

    const decision = decideExistingCluster({
      name,
      lifecycle: existing.lifecycle,
      wantReuse,
      lockLive: lockIsLive(state?.lock),
      unusableReason: state?.unusable,
    });

    if (decision.action === "refuse") {
      throw new Error(decision.message);
    }
    if (decision.action === "reuse") {
      log(`reusing k3d cluster ${name}`);
      return {
        target: target!,
        deleteAtEnd: undefined,
        importImages: (references) => provider.importImages(name, references),
      };
    }
    if (decision.action === "replace") {
      log(`replacing k3d cluster ${name} left over from an interrupted run`);
      await provider.delete(name);
      break;
    }
    if (Date.now() >= deadline) {
      throw new Error(`k3d cluster "${name}" is in use by ${describeLock(state?.lock)}`);
    }
    await delay(LOCK_POLL_MS);
  }

  log(`creating k3d cluster ${name}`);
  const startedAt = Date.now();
  await provider.create(name, { agents: options.agents ?? 0, lifecycle, k3sArgs: options.k3sArgs });
  const owned = { provider, name, directory };
  // From here a failure must still delete it, unless the user asked to keep it.
  if (!wantReuse) {
    control.onOwnedCluster(owned);
  }
  const target = await writeKubeconfig(provider, name, kubeconfigPath);
  log(`cluster ${name} ready in ${formatDuration(Date.now() - startedAt)}`);
  return {
    target,
    deleteAtEnd: wantReuse ? undefined : owned,
    importImages: (references) => provider.importImages(name, references),
  };
};

const prepareAttachedCluster = async (options: AttachedClusterOptions): Promise<Prepared> => {
  const target = { kubeconfigPath: options.kubeconfigPath, context: options.context };
  const state = await createClusterStateStore(createKubernetesClient(target)).read();
  if (!state?.marker && options.allowUnmarkedContext !== options.context) {
    throw new Error(
      `Context "${options.context}" has no vitekube marker, so it is not proven to be a test cluster. ` +
        `If it is disposable, set allowUnmarkedContext to "${options.context}".`
    );
  }
  if (state?.unusable) {
    throw new Error(`Context "${options.context}" is marked unusable: ${state.unusable}`);
  }
  return { target, deleteAtEnd: undefined };
};

const acquireLock = async (store: ClusterStateStore, lock: RunLock, lockWaitMs: number): Promise<void> => {
  const deadline = Date.now() + lockWaitMs;
  while (true) {
    const blocker = await store.acquireLock(lock, lockIsLive);
    if (!blocker) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`The cluster is in use by ${describeLock(blocker)}`);
    }
    await delay(LOCK_POLL_MS);
  }
};

/** A killed run on a kept cluster cannot remove its namespaces, so the next lock holder does. */
const sweepEphemeralNamespaces = async (client: KubernetesClient): Promise<void> => {
  const stale = await client.list<V1Namespace>(
    { apiVersion: "v1", kind: "Namespace" },
    { labelSelector: EPHEMERAL_NAMESPACE_LABEL }
  );
  for (const namespace of stale) {
    const name = namespace.metadata?.name;
    if (name && !namespace.metadata?.deletionTimestamp) {
      log(`removing namespace ${name} left over from an earlier run`);
      await client.delete({ apiVersion: "v1", kind: "Namespace", name });
    }
  }
};

/** Provisions the cluster for a run and cleans up after it. Use as the default export of a globalSetup file. */
export const defineK8sGlobalSetup =
  (options: K8sGlobalSetupOptions) =>
  async (project: TestProject): Promise<(() => Promise<void>) | undefined> => {
    if (isListCommand()) {
      return undefined;
    }

    const lockWaitMs = options.lockWaitMs ?? 0;
    const holder = randomUUID();
    const scope = createScope();
    let owned: NonNullable<Prepared["deleteAtEnd"]> | undefined;
    let store: ClusterStateStore | undefined;
    let lockHeld = false;
    let heartbeat: NodeJS.Timeout | undefined;

    // Vitest does not run global teardown on a signal. Only synchronous work is certain to finish here:
    // ownership of a cluster moves to a detached process, and a lock is cleared by the next run's liveness check.
    const onSignal = (signal: NodeJS.Signals): void => {
      removeSignalHandlers();
      killOwnedChildren();
      if (owned) {
        log(`interrupted, deleting k3d cluster ${owned.name} in the background`);
        owned.provider.deleteDetached(owned.name, owned.directory);
      }
      process.kill(process.pid, signal);
    };
    const removeSignalHandlers = (): void => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);

    const teardown = async (): Promise<void> => {
      clearInterval(heartbeat);
      const errors: unknown[] = [];
      await scope.dispose().catch((error: unknown) => errors.push(error));
      if (lockHeld && !owned) {
        await store?.releaseLock(holder).catch((error: unknown) => errors.push(error));
      }
      if (owned) {
        log(`deleting k3d cluster ${owned.name}`);
        await owned.provider.delete(owned.name).catch((error: unknown) => errors.push(error));
        await rm(owned.directory, { recursive: true, force: true });
      }
      removeSignalHandlers();
      if (errors.length > 0) {
        throw new AggregateError(errors, `vitekube teardown failed: ${errors.map(String).join("; ")}`);
      }
    };

    try {
      const { target, importImages } =
        options.cluster.provider === "attached"
          ? await prepareAttachedCluster(options.cluster)
          : await prepareManagedCluster(options.cluster, lockWaitMs, {
              onOwnedCluster: (cluster) => {
                owned = cluster;
              },
            });

      // A failure during setup is reported through this store too, so tests stop rather than cascade.
      const stateClient = createKubernetesClient(target);
      const stateStore = createClusterStateStore(stateClient);
      store = stateStore;
      await stateStore.initialize(MARKER);

      await acquireLock(
        stateStore,
        { holder, hostname: hostname(), pid: process.pid, expiresAt: Date.now() + LOCK_TTL_MS },
        lockWaitMs
      );
      lockHeld = true;
      heartbeat = setInterval(() => {
        stateStore.renewLock(holder, Date.now() + LOCK_TTL_MS).catch((error: unknown) => {
          console.error(`[vitekube] could not renew the run lock: ${String(error)}`);
        });
      }, HEARTBEAT_MS);
      heartbeat.unref();

      await sweepEphemeralNamespaces(stateClient);

      log(`watch the cluster with: KUBECONFIG=${target.kubeconfigPath} k9s --context ${target.context}`);
      project.provide("vitekubeTarget", target);
      project.provide("vitekubeRoot", project.config.root);

      const k8s = createKubernetesClient(target, {
        rootDir: project.config.root,
        onEnvironmentDamaged: (reason) => stateStore.markUnusable(reason),
      });
      if (options.environment) {
        await prepareEnvironment(options.environment, {
          vitestRoot: project.config.root,
          k8s,
          target,
          store: stateStore,
          importImages,
        });
      }
      if (options.setup) {
        await options.setup({
          k8s,
          target,
          scope,
          provide: (key, value) => project.provide(key as never, value as never),
        });
      }
    } catch (error) {
      await teardown().catch((teardownError: unknown) => {
        console.error(`[vitekube] cleanup after failed setup also failed: ${String(teardownError)}`);
      });
      throw error;
    }

    return teardown;
  };
