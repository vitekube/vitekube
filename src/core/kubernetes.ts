import {
  ApiException,
  KubeConfig,
  KubernetesObjectApi,
  PatchStrategy,
  type KubernetesObject,
  type V1Deployment,
  type V1Job,
  type V1Pod,
} from "@kubernetes/client-node";

import { createHelmObserver, type HelmObserver } from "./helm.ts";
import { startPortForward, type PortForward, type PortForwardOptions } from "./port-forward.ts";
import { run, runChecked, type RunResult } from "./process.ts";
import {
  isJobComplete,
  isPodReady,
  isRolloutComplete,
  summarizeDeployment,
  summarizeJob,
  summarizePod,
} from "./resources.ts";
import { waitFor, type WaitOptions } from "./wait.ts";

export type KubernetesTarget = {
  kubeconfigPath: string;
  context: string;
};

export type ResourceRef = {
  apiVersion: string;
  kind: string;
  name: string;
  namespace?: string;
};

export type NamedRef = {
  namespace: string;
  name: string;
};

export class KubernetesApiError extends Error {
  override name = "KubernetesApiError";
  readonly code: number;
  readonly reason: string | undefined;
  constructor(what: string, code: number, reason: string | undefined, message: string | undefined) {
    super(`${what} failed with ${code}${reason ? ` ${reason}` : ""}${message ? `: ${message}` : ""}`);
    this.code = code;
    this.reason = reason;
  }
}

type StatusBody = { reason?: string; message?: string; details?: { name?: string } };

const parseStatusBody = (body: unknown): StatusBody => {
  if (typeof body === "string") {
    try {
      return JSON.parse(body) as StatusBody;
    } catch {
      return {};
    }
  }
  return (body as StatusBody | null) ?? {};
};

/**
 * True only for the API server saying this named resource does not exist. A 404 from something else,
 * such as a proxy in front of the cluster, has no matching Status body and is not proof of absence.
 */
export const isNamedNotFound = (error: unknown, name: string): boolean => {
  if (!(error instanceof ApiException) || error.code !== 404) {
    return false;
  }
  const status = parseStatusBody(error.body);
  return status.reason === "NotFound" && status.details?.name === name;
};

const REQUEST_TIMEOUT_MS = 30_000;

/** The client has no per-request timeout of its own, so a hung API server would otherwise hang the test. */
const request = async <T>(what: string, call: () => Promise<T>, signal: AbortSignal | undefined): Promise<T> => {
  const { promise: stopped, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => reject(new Error(`${what} timed out after ${REQUEST_TIMEOUT_MS}ms`)),
    REQUEST_TIMEOUT_MS
  );
  const onAbort = (): void => reject(new Error(`${what} canceled`));
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([call(), stopped]);
  } catch (error) {
    if (error instanceof ApiException) {
      const status = parseStatusBody(error.body);
      throw new KubernetesApiError(what, error.code, status.reason, status.message);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
};

const toObject = ({ apiVersion, kind, name, namespace }: ResourceRef): KubernetesObject => ({
  apiVersion,
  kind,
  metadata: { name, namespace },
});

const describeRef = ({ kind, name, namespace }: ResourceRef): string =>
  `${kind} ${namespace ? `${namespace}/` : ""}${name}`;

export type TemporaryScale = {
  originalReplicas: number;
  /** Puts the original replica count back and waits for the rollout. Safe to call twice. */
  restore: () => Promise<void>;
  [Symbol.asyncDispose]: () => Promise<void>;
};

export type ClientOptions = {
  /** Cancels in-flight requests, commands and waits, for example when a test times out. */
  signal?: AbortSignal;
  /** Called when shared cluster state could not be restored, so later tests can stop instead of failing misleadingly. */
  onEnvironmentDamaged?: (reason: string) => Promise<void>;
};

export type KubernetesClient = {
  target: KubernetesTarget;
  helm: HelmObserver;
  /** Returns null only for a confirmed NotFound. Forbidden, transport and other failures throw. */
  get: <T extends KubernetesObject>(ref: ResourceRef) => Promise<T | null>;
  list: <T extends KubernetesObject>(
    resource: { apiVersion: string; kind: string; namespace?: string },
    options?: { labelSelector?: string }
  ) => Promise<T[]>;
  create: <T extends KubernetesObject>(resource: T) => Promise<T>;
  /** Fails with a 409 if `metadata.resourceVersion` is stale, which gives callers optimistic concurrency. */
  replace: <T extends KubernetesObject>(resource: T) => Promise<T>;
  patch: (ref: ResourceRef, changes: object) => Promise<void>;
  /** Treats an already absent resource as deleted. */
  delete: (ref: ResourceRef) => Promise<void>;
  apply: (namespace: string, manifest: object, options?: { private?: boolean }) => Promise<void>;
  waitForJobCompletion: (ref: NamedRef, options: WaitOptions) => Promise<V1Job>;
  waitForPodReady: (ref: NamedRef, options: WaitOptions) => Promise<V1Pod>;
  waitForRollout: (ref: NamedRef, options: WaitOptions) => Promise<V1Deployment>;
  logs: (ref: NamedRef, options?: { container?: string; tailLines?: number; previous?: boolean }) => Promise<string>;
  exec: (
    ref: NamedRef,
    command: string[],
    options?: { container?: string; input?: string | Uint8Array; private?: boolean; timeoutMs?: number }
  ) => Promise<RunResult>;
  portForward: (options: PortForwardOptions) => Promise<PortForward>;
  scaleTemporarily: (
    ref: NamedRef,
    replicas: number,
    options?: { restoreTimeoutMs?: number }
  ) => Promise<TemporaryScale>;
};

const KUBECTL_TIMEOUT_MS = 30_000;
const DEFAULT_RESTORE_TIMEOUT_MS = 120_000;

/** Every call names its kubeconfig and context, so the user's current context never matters. */
export const createKubernetesClient = (target: KubernetesTarget, options: ClientOptions = {}): KubernetesClient => {
  const { signal } = options;
  const config = new KubeConfig();
  config.loadFromFile(target.kubeconfigPath);
  if (!config.getContextObject(target.context)) {
    throw new Error(`Context "${target.context}" is not in ${target.kubeconfigPath}`);
  }
  config.setCurrentContext(target.context);
  const api = KubernetesObjectApi.makeApiClient(config);
  const scope = ["--kubeconfig", target.kubeconfigPath, "--context", target.context];

  const get: KubernetesClient["get"] = async <T extends KubernetesObject>(ref: ResourceRef) => {
    try {
      return await request(
        `Reading ${describeRef(ref)}`,
        async () => {
          try {
            return (await api.read(toObject(ref) as never)) as T;
          } catch (error) {
            if (isNamedNotFound(error, ref.name)) {
              return null;
            }
            throw error;
          }
        },
        signal
      );
    } catch (error) {
      if (error instanceof KubernetesApiError) {
        throw error;
      }
      throw new Error(`Reading ${describeRef(ref)} failed: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
  };

  const getRequired = async <T extends KubernetesObject>(ref: ResourceRef): Promise<T> => {
    const resource = await get<T>(ref);
    if (!resource) {
      throw new Error(`${describeRef(ref)} does not exist`);
    }
    return resource;
  };

  const patch: KubernetesClient["patch"] = async (ref, changes) => {
    await request(
      `Patching ${describeRef(ref)}`,
      () =>
        api.patch(
          { ...toObject(ref), ...changes },
          undefined,
          undefined,
          undefined,
          undefined,
          PatchStrategy.MergePatch
        ),
      signal
    );
  };

  const waitForRollout: KubernetesClient["waitForRollout"] = ({ namespace, name }, waitOptions) =>
    waitFor(
      () => getRequired<V1Deployment>({ apiVersion: "apps/v1", kind: "Deployment", namespace, name }),
      isRolloutComplete,
      { signal, ...waitOptions, describe: `rollout of ${namespace}/${name}`, summarize: summarizeDeployment }
    );

  return {
    target,
    helm: createHelmObserver(target, { signal }),
    get,
    patch,
    waitForRollout,

    list: async <T extends KubernetesObject>(
      { apiVersion, kind, namespace }: { apiVersion: string; kind: string; namespace?: string },
      listOptions: { labelSelector?: string } = {}
    ) => {
      const result = await request(
        `Listing ${kind}`,
        () =>
          api.list<T>(
            apiVersion,
            kind,
            namespace,
            undefined,
            undefined,
            undefined,
            undefined,
            listOptions.labelSelector
          ),
        signal
      );
      return result.items;
    },

    create: (resource) =>
      request(`Creating ${resource.kind} ${resource.metadata?.name}`, () => api.create(resource), signal),

    replace: (resource) =>
      request(`Replacing ${resource.kind} ${resource.metadata?.name}`, () => api.replace(resource), signal),

    delete: async (ref) => {
      await request(
        `Deleting ${describeRef(ref)}`,
        async () => {
          try {
            await api.delete(toObject(ref));
          } catch (error) {
            if (!isNamedNotFound(error, ref.name)) {
              throw error;
            }
          }
        },
        signal
      );
    },

    apply: async (namespace, manifest, applyOptions = {}) => {
      await runChecked("kubectl", [...scope, "apply", "--namespace", namespace, "--filename", "-"], {
        input: JSON.stringify(manifest),
        timeoutMs: KUBECTL_TIMEOUT_MS,
        signal,
        private: applyOptions.private,
      });
    },

    waitForJobCompletion: ({ namespace, name }, waitOptions) =>
      waitFor(() => getRequired<V1Job>({ apiVersion: "batch/v1", kind: "Job", namespace, name }), isJobComplete, {
        signal,
        ...waitOptions,
        describe: `Job ${namespace}/${name}`,
        summarize: summarizeJob,
      }),

    waitForPodReady: ({ namespace, name }, waitOptions) =>
      waitFor(() => getRequired<V1Pod>({ apiVersion: "v1", kind: "Pod", namespace, name }), isPodReady, {
        signal,
        ...waitOptions,
        describe: `Pod ${namespace}/${name}`,
        summarize: summarizePod,
      }),

    logs: async ({ namespace, name }, logOptions = {}) => {
      const args = [...scope, "logs", name, "--namespace", namespace];
      if (logOptions.container) args.push("--container", logOptions.container);
      if (logOptions.tailLines !== undefined) args.push(`--tail=${logOptions.tailLines}`);
      if (logOptions.previous) args.push("--previous");
      const { stdout } = await runChecked("kubectl", args, { timeoutMs: KUBECTL_TIMEOUT_MS, signal });
      return stdout;
    },

    exec: ({ namespace, name }, command, execOptions = {}) => {
      const args = [...scope, "exec", "--namespace", namespace];
      if (execOptions.input !== undefined) args.push("--stdin");
      args.push(name);
      if (execOptions.container) args.push("--container", execOptions.container);
      args.push("--", ...command);
      return run("kubectl", args, {
        input: execOptions.input,
        timeoutMs: execOptions.timeoutMs ?? KUBECTL_TIMEOUT_MS,
        signal,
        private: execOptions.private,
      });
    },

    portForward: (forwardOptions) => startPortForward(target, forwardOptions),

    scaleTemporarily: async ({ namespace, name }, replicas, scaleOptions = {}) => {
      const ref: ResourceRef = { apiVersion: "apps/v1", kind: "Deployment", namespace, name };
      const deployment = await getRequired<V1Deployment>(ref);
      const originalReplicas = deployment.spec?.replicas ?? 1;

      let restoring: Promise<void> | undefined;
      const restore = (): Promise<void> => {
        restoring ??= (async () => {
          try {
            // Not canceled with the test: a test that timed out still has to put this back.
            const restorer = createKubernetesClient(target);
            await restorer.patch(ref, { spec: { replicas: originalReplicas } });
            await restorer.waitForRollout(
              { namespace, name },
              { timeoutMs: scaleOptions.restoreTimeoutMs ?? DEFAULT_RESTORE_TIMEOUT_MS }
            );
          } catch (error) {
            const reason = `could not restore ${namespace}/${name} to ${originalReplicas} replica(s): ${
              error instanceof Error ? error.message : String(error)
            }`;
            await options.onEnvironmentDamaged?.(reason);
            throw new Error(reason, { cause: error });
          }
        })();
        return restoring;
      };

      try {
        await patch(ref, { spec: { replicas } });
      } catch (error) {
        await restore().catch(() => {});
        throw error;
      }

      return { originalReplicas, restore, [Symbol.asyncDispose]: restore };
    },
  };
};
