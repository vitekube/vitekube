import type { ContainerStateName } from "../core/resources.ts";

type K8sMatchers<R = unknown> = {
  toHaveCondition: (type: string, status?: string) => R;
  toBePodReady: () => R;
  toHaveContainerState: (container: string, state: ContainerStateName) => R;
};

// Kept in its own file and imported for its side effect, as with provided.ts, so the bundled types keep it.
declare module "vitest" {
  // Both parameters must match Vitest's declaration to merge with it. This form needs Vitest 5.
  interface Matchers<R, T> extends K8sMatchers<R> {}
}
