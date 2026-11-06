import { K8sReporter } from "vitekube/node";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./k8s.setup.ts"],
    reporters: [new K8sReporter()],
    fileParallelism: false,
    testTimeout: 180_000,
    teardownTimeout: 120_000,
  },
});
