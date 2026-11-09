import type { CoreV1Event, V1Pod } from "@kubernetes/client-node";

import type { KubernetesClient } from "../core/kubernetes.ts";
import { summarizePod } from "../core/resources.ts";
import type { Evidence } from "./evidence.ts";

export type ResourceEvidenceOptions = {
  namespace: string;
  /** Selects Pods and their events. Without a selector, includes every Pod and event in the namespace. */
  labelSelector?: string;
  /** Lines per container log. Defaults to 100. */
  tailLines?: number;
  /** Also collect previous logs for containers with observed restarts. Defaults to true. */
  previous?: boolean;
};

export type ResourceEvidenceClient = Pick<KubernetesClient, "list" | "logs">;

/** Registers lazy collectors, so they inspect the failed state before fixture cleanup. */
export const addResourceEvidence = (
  evidence: Pick<Evidence, "add">,
  client: ResourceEvidenceClient,
  options: ResourceEvidenceOptions
): void => {
  const { namespace, labelSelector, tailLines = 100, previous = true } = options;
  const description = `in ${namespace}${labelSelector ? ` matching ${labelSelector}` : ""}`;
  const pods = () => client.list<V1Pod>({ apiVersion: "v1", kind: "Pod", namespace }, { labelSelector });

  evidence.add(`events ${description}`, async () => {
    const events = await client.list<CoreV1Event>({ apiVersion: "v1", kind: "Event", namespace });
    const selected = labelSelector ? new Set((await pods()).map((pod) => pod.metadata?.uid)) : undefined;
    return events
      .filter(
        (event) =>
          !selected ||
          (event.involvedObject.kind === "Pod" &&
            Boolean(event.involvedObject.uid) &&
            selected.has(event.involvedObject.uid))
      )
      .map(
        (event) =>
          `${event.type} ${event.reason} ${event.involvedObject.kind}/${event.involvedObject.name}: ${event.message}`
      )
      .join("\n");
  });
  evidence.add(`pods ${description}`, async () =>
    (await pods())
      .map(
        (pod) =>
          `${pod.metadata?.name}${pod.metadata?.deletionTimestamp ? " (terminating)" : ""} ${JSON.stringify(summarizePod(pod))}`
      )
      .join("\n")
  );
  evidence.add(
    `logs ${description}`,
    async () => {
      const sections = (await pods()).flatMap((pod) => {
        const name = pod.metadata?.name ?? "";
        const containers = [
          ...(pod.spec?.initContainers ?? []),
          ...(pod.spec?.containers ?? []),
          ...(pod.spec?.ephemeralContainers ?? []),
        ];
        const statuses = [
          ...(pod.status?.initContainerStatuses ?? []),
          ...(pod.status?.containerStatuses ?? []),
          ...(pod.status?.ephemeralContainerStatuses ?? []),
        ];
        return containers.flatMap(({ name: container }) => {
          const restarted = statuses.some((status) => status.name === container && status.restartCount > 0);
          const versions = previous && restarted ? [false, true] : [false];
          return versions.map(async (isPrevious) => {
            const logs = await client
              .logs({ namespace, name }, { container, tailLines, previous: isPrevious })
              .catch((error: unknown) => `could not read: ${String(error)}`);
            return `${name}/${container}${isPrevious ? " (previous)" : ""}:\n${logs}`;
          });
        });
      });
      return (await Promise.all(sections)).join("\n");
    },
    { mayContainSensitiveData: true }
  );
};
