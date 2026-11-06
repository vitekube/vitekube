import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { fingerprintFiles, hashParts, planStages, validateStages } from "../cluster/environment-plan.ts";
import type { ClusterStateStore } from "../cluster/state.ts";
import { formatDuration } from "../core/duration.ts";
import type { KubernetesClient, KubernetesTarget, NamedRef } from "../core/kubernetes.ts";
import { runChecked } from "../core/process.ts";

export type ImageSpec = {
  name: string;
  /** Defaults to `local`. Test charts then point at this same reference. */
  tag?: string;
  dockerfile: string;
  context: string;
};

export type StageContext = {
  k8s: KubernetesClient;
  target: KubernetesTarget;
  rootDir: string;
};

export type ChartSpec = {
  release: string;
  chart: string;
  namespace?: string;
  values?: readonly string[];
  /** Written to a private file and removed afterward. Errors from this chart's Helm call are then hidden too. */
  privateValues?: (context: StageContext) => object | Promise<object>;
  /** Waits for the release's resources. The default is to wait only for `restart`. */
  wait?: boolean;
  /** Deployments to restart and wait for, because a rebuilt image usually keeps its tag. */
  restart?: readonly string[];
};

export type StageSpec = {
  name: string;
  /** Stages this one needs. They must be declared earlier, and when one runs, this one does too. */
  dependsOn?: readonly string[];
  /** Images this stage deploys. A changed image reruns the stage. */
  images?: readonly string[];
  /** Files or globs that `run` reads, relative to `rootDir`. Charts and manifests are tracked automatically. */
  inputs?: readonly string[];
  manifests?: readonly string[];
  /** Deployments that must roll out after `manifests` are applied. */
  waitFor?: readonly NamedRef[];
  charts?: readonly ChartSpec[];
  /** For anything a declaration cannot express. Runs last in the stage. */
  run?: (context: StageContext) => Promise<void>;
};

export type EnvironmentSpec = {
  /** The base of every path here, relative to Vitest's root. Defaults to Vitest's root. */
  rootDir?: string;
  images?: readonly ImageSpec[];
  stages: readonly StageSpec[];
};

const log = (message: string): void => console.log(`[vitekube] ${message}`);

const elapsed = (startedAt: number): string => formatDuration(Date.now() - startedAt);

const BUILD_TIMEOUT_MS = 900_000;
const APPLY_TIMEOUT_MS = 60_000;
const HELM_TIMEOUT_MS = 300_000;
const ROLLOUT_TIMEOUT_MS = 180_000;

const imageRef = ({ name, tag = "local" }: ImageSpec): string => `${name}:${tag}`;

/** Always asks Docker, because its layer cache is the only exact answer to whether an image changed. */
const buildImage = async (image: ImageSpec, rootDir: string): Promise<string> => {
  const startedAt = Date.now();
  const ref = imageRef(image);
  await runChecked(
    "docker",
    ["build", "--file", resolve(rootDir, image.dockerfile), "--tag", ref, resolve(rootDir, image.context)],
    { cwd: rootDir, timeoutMs: BUILD_TIMEOUT_MS }
  );
  const { stdout } = await runChecked("docker", ["image", "inspect", "--format", "{{.Id}}", ref], {
    timeoutMs: APPLY_TIMEOUT_MS,
  });
  log(`image ${ref} checked in ${elapsed(startedAt)}`);
  return stdout.trim();
};

const kubeArgs = ({ kubeconfigPath, context }: KubernetesTarget): string[] => [
  "--kubeconfig",
  kubeconfigPath,
  "--context",
  context,
];

const helmKubeArgs = ({ kubeconfigPath, context }: KubernetesTarget): string[] => [
  "--kubeconfig",
  kubeconfigPath,
  "--kube-context",
  context,
];

const installChart = async (chart: ChartSpec, context: StageContext): Promise<void> => {
  const { rootDir, target, k8s } = context;
  const namespace = chart.namespace ?? "default";
  const args = [
    "upgrade",
    "--install",
    chart.release,
    resolve(rootDir, chart.chart),
    "--namespace",
    namespace,
    "--create-namespace",
    ...helmKubeArgs(target),
    ...(chart.values ?? []).flatMap((path) => ["--values", resolve(rootDir, path)]),
    ...(chart.wait ? ["--wait", "--timeout", `${HELM_TIMEOUT_MS / 1000 - 10}s`] : []),
  ];

  if (chart.privateValues) {
    const directory = await mkdtemp(join(tmpdir(), "vitekube-values-"));
    try {
      const path = join(directory, "values.json");
      await writeFile(path, JSON.stringify(await chart.privateValues(context)), { mode: 0o600 });
      await runChecked("helm", [...args, "--values", path], { private: true, timeoutMs: HELM_TIMEOUT_MS });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  } else {
    await runChecked("helm", args, { timeoutMs: HELM_TIMEOUT_MS });
  }

  for (const name of chart.restart ?? []) {
    await runChecked(
      "kubectl",
      [...kubeArgs(target), "rollout", "restart", `deployment/${name}`, "--namespace", namespace],
      { timeoutMs: APPLY_TIMEOUT_MS }
    );
    await k8s.waitForRollout({ namespace, name }, { timeoutMs: ROLLOUT_TIMEOUT_MS });
  }
};

const runStage = async (stage: StageSpec, context: StageContext): Promise<void> => {
  const { rootDir, target, k8s } = context;
  for (const manifest of stage.manifests ?? []) {
    await runChecked("kubectl", [...kubeArgs(target), "apply", "--filename", resolve(rootDir, manifest)], {
      timeoutMs: APPLY_TIMEOUT_MS,
    });
  }
  for (const deployment of stage.waitFor ?? []) {
    await k8s.waitForRollout(deployment, { timeoutMs: ROLLOUT_TIMEOUT_MS });
  }
  for (const chart of stage.charts ?? []) {
    await installChart(chart, context);
  }
  await stage.run?.(context);
};

const stageFingerprint = (stage: StageSpec, rootDir: string, imageIds: Readonly<Record<string, string>>): string => {
  const files = [
    ...(stage.inputs ?? []),
    ...(stage.manifests ?? []),
    ...(stage.charts ?? []).flatMap((chart) => [chart.chart, ...(chart.values ?? [])]),
  ];
  const shape = (stage.charts ?? []).map(({ release, namespace, restart, wait }) => ({
    release,
    namespace,
    restart,
    wait,
  }));
  return hashParts([
    JSON.stringify(shape),
    ...(stage.images ?? []).map((name) => `${name}:${imageIds[name]}`),
    ...fingerprintFiles(rootDir, files),
  ]);
};

/** Brings the cluster to the declared state, doing only the work that the declaration's inputs call for. */
export const prepareEnvironment = async (
  spec: EnvironmentSpec,
  input: {
    vitestRoot: string;
    k8s: KubernetesClient;
    target: KubernetesTarget;
    store: ClusterStateStore;
    /** Undefined on an attached cluster, where images cannot be imported. */
    importImages: ((references: readonly string[]) => Promise<void>) | undefined;
  }
): Promise<void> => {
  const { k8s, target, store, importImages } = input;
  const rootDir = resolve(input.vitestRoot, spec.rootDir ?? ".");
  const images = spec.images ?? [];
  validateStages(
    spec.stages,
    images.map((image) => image.name)
  );
  if (images.length > 0 && !importImages) {
    throw new Error("Declared images can only be imported into a managed cluster");
  }
  const force = process.env.VITEKUBE_REBUILD === "1";

  const startedAt = Date.now();
  const built = await Promise.all(images.map(async (image) => [image, await buildImage(image, rootDir)] as const));
  const imageIds = Object.fromEntries(built.map(([image, id]) => [image.name, id]));

  const recorded = await store.readEnvironment();
  const changed = built.filter(([image, id]) => force || recorded.images[image.name] !== id).map(([image]) => image);
  if (changed.length > 0) {
    const importStartedAt = Date.now();
    await importImages?.(changed.map(imageRef));
    for (const image of changed) {
      await store.recordImage(image.name, imageIds[image.name] as string);
    }
    log(`imported ${changed.map(imageRef).join(", ")} in ${elapsed(importStartedAt)}`);
  } else if (images.length > 0) {
    log("images unchanged, nothing to import");
  }

  const fingerprints = Object.fromEntries(
    spec.stages.map((stage) => [stage.name, stageFingerprint(stage, rootDir, imageIds)])
  );
  const decisions = planStages(spec.stages, fingerprints, recorded.stages, { force });

  // Cleared before anything runs. Otherwise a stage failing after its dependency changed would look current next time.
  for (const decision of decisions) {
    if (decision.run) await store.recordStage(decision.name, undefined);
  }

  const context: StageContext = { k8s, target, rootDir };
  for (const [index, stage] of spec.stages.entries()) {
    const decision = decisions[index]!;
    if (!decision.run) {
      log(`stage ${stage.name}: skipped, ${decision.reason}`);
      continue;
    }
    log(`stage ${stage.name}: running, because ${decision.reason}`);
    const stageStartedAt = Date.now();
    await runStage(stage, context);
    await store.recordStage(stage.name, fingerprints[stage.name]);
    log(`stage ${stage.name}: done in ${elapsed(stageStartedAt)}`);
  }
  log(`environment ready in ${elapsed(startedAt)}`);
};
