import type { V1Condition, V1Deployment, V1Job, V1JobCondition, V1Pod, V1PodCondition } from "@kubernetes/client-node";

type AnyCondition = V1Condition | V1JobCondition | V1PodCondition;

const conditionsOf = (resource: unknown): AnyCondition[] =>
  (resource as { status?: { conditions?: AnyCondition[] } } | null)?.status?.conditions ?? [];

export const findCondition = (resource: unknown, type: string): AnyCondition | undefined =>
  conditionsOf(resource).find((condition) => condition.type === type);

export const hasCondition = (resource: unknown, type: string, status = "True"): boolean =>
  findCondition(resource, type)?.status === status;

export class JobFailedError extends Error {
  override name = "JobFailedError";
  constructor(job: V1Job) {
    const reason = findCondition(job, "Failed")?.reason ?? "unknown reason";
    super(`Job ${job.metadata?.namespace}/${job.metadata?.name} failed: ${reason}`);
  }
}

export class PodTerminatedError extends Error {
  override name = "PodTerminatedError";
  constructor(pod: V1Pod) {
    super(`Pod ${pod.metadata?.namespace}/${pod.metadata?.name} ended in phase ${pod.status?.phase}`);
  }
}

export class RolloutFailedError extends Error {
  override name = "RolloutFailedError";
  constructor(deployment: V1Deployment) {
    const reason = findCondition(deployment, "Progressing")?.reason ?? "unknown reason";
    super(`Rollout of ${deployment.metadata?.namespace}/${deployment.metadata?.name} failed: ${reason}`);
  }
}

/** Complete=True only. Failed pods alone do not end a wait, because the Job may still retry. */
export const isJobComplete = (job: V1Job): boolean => {
  if (hasCondition(job, "Failed")) {
    throw new JobFailedError(job);
  }
  return hasCondition(job, "Complete");
};

export const isPodReady = (pod: V1Pod): boolean => {
  if (pod.status?.phase === "Failed" || pod.status?.phase === "Succeeded") {
    throw new PodTerminatedError(pod);
  }
  return hasCondition(pod, "Ready");
};

/**
 * Requires the controller to have seen the current generation, so a stale Available condition
 * from before an update cannot pass, and every replica to be updated and available.
 */
export const isRolloutComplete = (deployment: V1Deployment): boolean => {
  if (findCondition(deployment, "Progressing")?.reason === "ProgressDeadlineExceeded") {
    throw new RolloutFailedError(deployment);
  }
  const status = deployment.status;
  const wanted = deployment.spec?.replicas ?? 1;
  return (
    deployment.metadata?.generation === status?.observedGeneration &&
    (status?.updatedReplicas ?? 0) === wanted &&
    (status?.replicas ?? 0) === wanted &&
    (status?.availableReplicas ?? 0) === wanted
  );
};

// Summaries report status only. Specs can hold secret values, such as container environment.

export const summarizeJob = (job: V1Job): unknown => ({
  active: job.status?.active,
  succeeded: job.status?.succeeded,
  failed: job.status?.failed,
  conditions: conditionsOf(job).map(({ type, status, reason }) => ({ type, status, reason })),
});

export type ContainerStateName = "waiting" | "running" | "terminated";

export const containerStateOf = (
  pod: V1Pod,
  container: string
): { state: ContainerStateName; reason?: string; exitCode?: number } | undefined => {
  const statuses = [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])];
  const state = statuses.find((status) => status.name === container)?.state;
  if (state?.terminated) {
    return { state: "terminated", reason: state.terminated.reason, exitCode: state.terminated.exitCode };
  }
  if (state?.running) {
    return { state: "running" };
  }
  if (state?.waiting) {
    return { state: "waiting", reason: state.waiting.reason };
  }
  return undefined;
};

export const summarizePod = (pod: V1Pod): unknown => ({
  phase: pod.status?.phase,
  conditions: conditionsOf(pod).map(({ type, status, reason }) => ({ type, status, reason })),
  containers: (pod.status?.containerStatuses ?? []).map((status) => ({
    name: status.name,
    ready: status.ready,
    ...containerStateOf(pod, status.name),
  })),
});

export const summarizeDeployment = (deployment: V1Deployment): unknown => ({
  generation: deployment.metadata?.generation,
  observedGeneration: deployment.status?.observedGeneration,
  wanted: deployment.spec?.replicas,
  replicas: deployment.status?.replicas,
  updated: deployment.status?.updatedReplicas,
  available: deployment.status?.availableReplicas,
  conditions: conditionsOf(deployment).map(({ type, status, reason }) => ({ type, status, reason })),
});
