import { defineConfig } from "vitest/config";

import { K8sReporter } from "../src/node.ts";

export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ["*.test.ts"],
    globalSetup: ["./k8s.setup.ts"],
    reporters: [new K8sReporter()],
    fileParallelism: false,
    testTimeout: 180_000,
    teardownTimeout: 120_000,
  },
});
