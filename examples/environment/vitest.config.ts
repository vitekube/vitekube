import { K8sReporter } from "vitekube/node";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["*.test.ts"],
    globalSetup: ["./k8s.setup.ts"],
    reporters: [new K8sReporter()],
    fileParallelism: false,
    testTimeout: 180_000,
    // Teardown deletes the cluster. This leaves room beyond the 10s default for slower machines.
    teardownTimeout: 120_000,
  },
});
