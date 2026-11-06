import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { defineK8sGlobalSetup } from "vitekube/node";

export default defineK8sGlobalSetup({
  cluster: { provider: "k3d", name: "vitekube-environment", reuse: process.env.EXAMPLE_FRESH !== "1" },
  environment: {
    images: [{ name: "example-app", dockerfile: "app/Dockerfile", context: "app" }],
    stages: [
      {
        name: "dependency",
        manifests: ["manifests/dependency.yaml"],
        waitFor: [{ namespace: "default", name: "dependency" }],
      },
      {
        name: "seed",
        dependsOn: ["dependency"],
        inputs: ["inputs/*.txt"],
        run: async ({ k8s, rootDir }) => {
          if (process.env.EXAMPLE_FAIL_SEED === "1") {
            throw new Error("Seed failed on request");
          }
          await k8s.apply("default", {
            apiVersion: "v1",
            kind: "ConfigMap",
            metadata: { name: "seed" },
            data: { seed: readFileSync(resolve(rootDir, "inputs/seed.txt"), "utf8") },
          });
        },
      },
      {
        name: "app",
        dependsOn: ["seed"],
        images: ["example-app"],
        charts: [
          {
            release: "example-app",
            chart: "chart",
            restart: ["example-app"],
            privateValues: () => ({ secretValue: process.env.EXAMPLE_SECRET ?? "not-set" }),
          },
        ],
      },
    ],
  },
});
