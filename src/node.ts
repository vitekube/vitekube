// Entry point for code running in Vitest's main process: globalSetup files and vitest.config.ts.
// It must not import the `vitest` runtime, which only works inside test workers.
export {
  defineK8sGlobalSetup,
  type AttachedClusterOptions,
  type K8sGlobalSetupOptions,
  type K8sSetupContext,
  type ManagedClusterOptions,
} from "./vitest/global-setup.ts";
export type { ChartSpec, EnvironmentSpec, ImageSpec, StageContext, StageSpec } from "./vitest/environment.ts";
export { K8sReporter } from "./vitest/k8s-reporter.ts";
export { RequireMatchingTests } from "./vitest/require-matching-tests.ts";
