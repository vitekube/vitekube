import { spawn } from "node:child_process";

import { run, runChecked, type RunOptions } from "../core/process.ts";

export type ManagedLifecycle = "fresh" | "reuse";

type ExistingCluster = {
  /** Set only on clusters this package created. A cluster without it is never reused or deleted. */
  lifecycle: ManagedLifecycle | undefined;
};

export type ClusterProvider = {
  find: (name: string) => Promise<ExistingCluster | null>;
  create: (
    name: string,
    options: { agents: number; lifecycle: ManagedLifecycle; k3sArgs?: readonly string[] }
  ) => Promise<void>;
  /** Returns kubeconfig YAML for the cluster, and the context to use in it. */
  kubeconfig: (name: string) => Promise<{ yaml: string; context: string }>;
  delete: (name: string) => Promise<void>;
  importImages: (name: string, references: readonly string[]) => Promise<void>;
  /** Starts a deletion that outlives this process, for use while it is being interrupted. */
  deleteDetached: (name: string, thenRemove: string) => void;
};

const CREATE_TIMEOUT_MS = 300_000;
const COMMAND_TIMEOUT_MS = 120_000;
const IMPORT_TIMEOUT_MS = 600_000;
const LIFECYCLE_LABEL = "vitekube.lifecycle";

/** Parses one label value per container. Containers without the label print an empty line. */
export const parseLifecycleLabels = (output: string): ManagedLifecycle | undefined => {
  for (const line of output.split("\n")) {
    const value = line.trim();
    if (value === "fresh" || value === "reuse") {
      return value;
    }
  }
  return undefined;
};

/**
 * `privateKubeconfigPath` becomes k3d's default kubeconfig, because `k3d cluster delete` edits the default one
 * and has no flag to prevent that. The user's own kubeconfig is never read or changed.
 *
 * The lifecycle label lives on the k3d containers rather than in the cluster, so a run interrupted before
 * the API server is up still leaves a cluster that is recognizably ours.
 */
export const createK3dProvider = (privateKubeconfigPath: string): ClusterProvider => {
  const env = { ...process.env, KUBECONFIG: privateKubeconfigPath };
  const commandOptions: RunOptions = { env, timeoutMs: COMMAND_TIMEOUT_MS };

  return {
    find: async (name) => {
      const result = await run("k3d", ["cluster", "list", "--output", "json"], commandOptions);
      if (result.status !== 0) {
        throw new Error(`Could not list k3d clusters: ${result.stderr.trim()}`);
      }
      const clusters = JSON.parse(result.stdout) as { name: string }[];
      if (!clusters.some((cluster) => cluster.name === name)) {
        return null;
      }
      // `k3d cluster list` leaves out custom runtime labels, so they are read from Docker.
      const { stdout } = await runChecked(
        "docker",
        ["ps", "--all", "--filter", `label=k3d.cluster=${name}`, "--format", `{{.Label "${LIFECYCLE_LABEL}"}}`],
        commandOptions
      );
      return { lifecycle: parseLifecycleLabels(stdout) };
    },

    create: async (name, { agents, lifecycle, k3sArgs = [] }) => {
      await runChecked(
        "k3d",
        [
          "cluster",
          "create",
          name,
          "--agents",
          String(agents),
          "--wait",
          "--kubeconfig-update-default=false",
          "--kubeconfig-switch-context=false",
          "--runtime-label",
          `${LIFECYCLE_LABEL}=${lifecycle}@server:*`,
          ...k3sArgs.flatMap((arg) => ["--k3s-arg", arg]),
        ],
        { env, timeoutMs: CREATE_TIMEOUT_MS }
      );
    },

    kubeconfig: async (name) => {
      const { stdout } = await runChecked("k3d", ["kubeconfig", "get", name], commandOptions);
      return { yaml: stdout, context: `k3d-${name}` };
    },

    delete: async (name) => {
      await runChecked("k3d", ["cluster", "delete", name], commandOptions);
    },

    importImages: async (name, references) => {
      await runChecked("k3d", ["image", "import", "--mode", "direct", "--cluster", name, ...references], {
        env,
        timeoutMs: IMPORT_TIMEOUT_MS,
      });
    },

    deleteDetached: (name, thenRemove) => {
      spawn("sh", ["-c", 'k3d cluster delete "$1"; rm -rf "$2"', "sh", name, thenRemove], {
        detached: true,
        env,
        stdio: "ignore",
      }).unref();
    },
  };
};
