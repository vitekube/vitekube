import type { V1Pod } from "@kubernetes/client-node";

import { containerStateOf, findCondition, hasCondition, type ContainerStateName } from "../core/resources.ts";

// Failure messages name only the fields being checked. Printing the whole object would show
// its spec, and a Pod's spec can hold secret values.

type MatcherResult = { pass: boolean; message: () => string };

const nameOf = (resource: unknown): string => {
  const { kind, metadata } = (resource ?? {}) as { kind?: string; metadata?: { name?: string } };
  return [kind, metadata?.name].filter(Boolean).join(" ") || "resource";
};

export const toHaveCondition = (received: unknown, type: string, status = "True"): MatcherResult => {
  const actual = findCondition(received, type);
  return {
    pass: hasCondition(received, type, status),
    message: () =>
      `expected ${nameOf(received)} to have condition ${type}=${status}, but it is ` +
      (actual ? `${type}=${actual.status}${actual.reason ? ` (${actual.reason})` : ""}` : "absent"),
  };
};

export const toBePodReady = (received: V1Pod): MatcherResult => {
  const actual = findCondition(received, "Ready");
  return {
    pass: hasCondition(received, "Ready"),
    message: () =>
      `expected ${nameOf(received)} to be Ready, but its phase is ${received.status?.phase} ` +
      `and Ready is ${actual ? actual.status : "absent"}${actual?.reason ? ` (${actual.reason})` : ""}`,
  };
};

export const toHaveContainerState = (received: V1Pod, container: string, state: ContainerStateName): MatcherResult => {
  const actual = containerStateOf(received, container);
  return {
    pass: actual?.state === state,
    message: () =>
      `expected container ${container} of ${nameOf(received)} to be ${state}, but it is ` +
      (actual ? `${actual.state}${actual.reason ? ` (${actual.reason})` : ""}` : "not reported"),
  };
};
