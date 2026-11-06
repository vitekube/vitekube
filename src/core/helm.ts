import { run } from "./process.ts";
import type { KubernetesTarget } from "./kubernetes.ts";

export type HelmRelease = {
  name: string;
  namespace: string;
  /** Helm's status, such as `deployed`, `failed` or `pending-install`. */
  status: string;
  revision: number;
};

export type HelmObserver = {
  /** Returns null only when Helm confirms the release does not exist. Any other failure throws. */
  status: (release: { namespace: string; name: string }) => Promise<HelmRelease | null>;
};

const HELM_TIMEOUT_MS = 30_000;

export const isReleaseNotFound = (stderr: string): boolean => /\brelease: not found\b/.test(stderr);

/** Parses only identity and status, because `helm status` output also contains the release's values. */
export const parseHelmStatus = (stdout: string): HelmRelease => {
  const parsed = JSON.parse(stdout) as { name: string; namespace: string; version: number; info: { status: string } };
  return { name: parsed.name, namespace: parsed.namespace, status: parsed.info.status, revision: parsed.version };
};

export const createHelmObserver = (target: KubernetesTarget, options: { signal?: AbortSignal } = {}): HelmObserver => ({
  status: async ({ namespace, name }) => {
    const result = await run(
      "helm",
      [
        "status",
        name,
        "--namespace",
        namespace,
        "--kubeconfig",
        target.kubeconfigPath,
        "--kube-context",
        target.context,
        "--output",
        "json",
      ],
      { timeoutMs: HELM_TIMEOUT_MS, signal: options.signal, private: true }
    );
    if (result.status === 0) {
      return parseHelmStatus(result.stdout);
    }
    if (isReleaseNotFound(result.stderr)) {
      return null;
    }
    throw new Error(`Could not read Helm release ${namespace}/${name}: ${result.stderr.trim()}`);
  },
});
