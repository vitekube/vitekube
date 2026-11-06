import type { V1ConfigMap } from "@kubernetes/client-node";

import { KubernetesApiError, type KubernetesClient } from "../core/kubernetes.ts";
import type { RunLock } from "./lock.ts";

const STATE_NAMESPACE = "vitekube-system";
const STATE_NAME = "state";
const UPDATE_ATTEMPTS = 10;

export type ClusterState = {
  /** Proof that this is a disposable test cluster. */
  marker: string | undefined;
  lock: RunLock | undefined;
  unusable: string | undefined;
};

const stateRef = { apiVersion: "v1", kind: "ConfigMap", namespace: STATE_NAMESPACE, name: STATE_NAME };

const parseState = (configMap: V1ConfigMap): ClusterState => {
  const data = configMap.data ?? {};
  return {
    marker: data.marker,
    lock: data.lock ? (JSON.parse(data.lock) as RunLock) : undefined,
    unusable: data.unusable,
  };
};

const ignoreConflict = (error: unknown): void => {
  if (!(error instanceof KubernetesApiError && error.code === 409)) {
    throw error;
  }
};

export type EnvironmentRecord = {
  /** Fingerprint of each stage's last successful run. */
  stages: Record<string, string>;
  /** Id of each image last imported into the cluster. */
  images: Record<string, string>;
};

const parseEnvironment = (value: string | undefined): EnvironmentRecord =>
  value ? (JSON.parse(value) as EnvironmentRecord) : { stages: {}, images: {} };

export type ClusterStateStore = {
  /** Returns null when the cluster has no state yet. An unreachable cluster throws. */
  read: () => Promise<ClusterState | null>;
  /** Creates the state object carrying the marker, and leaves an existing one alone. */
  initialize: (marker: string) => Promise<void>;
  /** Returns the lock that blocked acquisition, or null if this holder now has it. */
  acquireLock: (lock: RunLock, isLive: (current: RunLock | undefined) => boolean) => Promise<RunLock | null>;
  renewLock: (holder: string, expiresAt: number) => Promise<void>;
  releaseLock: (holder: string) => Promise<void>;
  markUnusable: (reason: string) => Promise<void>;
  readEnvironment: () => Promise<EnvironmentRecord>;
  /** `undefined` clears the record, so the stage runs next time. */
  recordStage: (name: string, fingerprint: string | undefined) => Promise<void>;
  recordImage: (name: string, id: string) => Promise<void>;
};

export const createClusterStateStore = (client: KubernetesClient): ClusterStateStore => {
  /** Reads, changes and writes with optimistic concurrency, retrying when another writer got in first. */
  const update = async <T>(change: (data: Record<string, string>) => T): Promise<T> => {
    for (let attempt = 0; attempt < UPDATE_ATTEMPTS; attempt += 1) {
      const current = await client.get<V1ConfigMap>(stateRef);
      if (!current) {
        throw new Error(`Cluster state ${STATE_NAMESPACE}/${STATE_NAME} does not exist`);
      }
      const data = { ...current.data };
      const result = change(data);
      try {
        // oxlint-disable-next-line typescript/no-misused-spread -- the client serializes plain objects too.
        await client.replace({ ...current, data });
        return result;
      } catch (error) {
        ignoreConflict(error);
      }
    }
    throw new Error(`Could not update cluster state after ${UPDATE_ATTEMPTS} attempts`);
  };

  return {
    read: async () => {
      const configMap = await client.get<V1ConfigMap>(stateRef);
      return configMap ? parseState(configMap) : null;
    },

    initialize: async (marker) => {
      await client
        .create({ apiVersion: "v1", kind: "Namespace", metadata: { name: STATE_NAMESPACE } })
        .catch(ignoreConflict);
      await client
        .create({
          apiVersion: "v1",
          kind: "ConfigMap",
          metadata: { name: STATE_NAME, namespace: STATE_NAMESPACE },
          data: { marker },
        } satisfies V1ConfigMap)
        .catch(ignoreConflict);
    },

    acquireLock: (lock, isLive) =>
      update((data) => {
        const current = data.lock ? (JSON.parse(data.lock) as RunLock) : undefined;
        if (current && current.holder !== lock.holder && isLive(current)) {
          return current;
        }
        data.lock = JSON.stringify(lock);
        return null;
      }),

    renewLock: (holder, expiresAt) =>
      update((data) => {
        const current = data.lock ? (JSON.parse(data.lock) as RunLock) : undefined;
        if (current?.holder === holder) {
          data.lock = JSON.stringify({ ...current, expiresAt });
        }
      }),

    releaseLock: (holder) =>
      update((data) => {
        const current = data.lock ? (JSON.parse(data.lock) as RunLock) : undefined;
        if (current?.holder === holder) {
          delete data.lock;
        }
      }),

    markUnusable: (reason) =>
      update((data) => {
        data.unusable = reason;
      }),

    readEnvironment: async () => parseEnvironment((await client.get<V1ConfigMap>(stateRef))?.data?.environment),

    recordStage: (name, fingerprint) =>
      update((data) => {
        const environment = parseEnvironment(data.environment);
        if (fingerprint === undefined) {
          delete environment.stages[name];
        } else {
          environment.stages[name] = fingerprint;
        }
        data.environment = JSON.stringify(environment);
      }),

    recordImage: (name, id) =>
      update((data) => {
        const environment = parseEnvironment(data.environment);
        environment.images[name] = id;
        data.environment = JSON.stringify(environment);
      }),
  };
};
