import { defineK8sGlobalSetup } from "../src/node.ts";
import { webDeployment, webService } from "./workloads.ts";

declare module "vitest" {
  export interface ProvidedContext {
    sharedWebUrl: string;
  }
}

export default defineK8sGlobalSetup({
  cluster: { provider: "k3d", name: "vitekube-e2e", reuse: process.env.VITEKUBE_E2E_REUSE === "1" },
  // Proves a long-lived port-forward opened here reaches tests as a plain URL.
  setup: async ({ k8s, scope, provide }) => {
    await k8s.apply("default", webDeployment("shared-web"));
    await k8s.apply("default", webService("shared-web"));
    await k8s.waitForRollout({ namespace: "default", name: "shared-web" }, { timeoutMs: 120_000 });
    const forward = await k8s.portForward({ namespace: "default", resource: "service/shared-web", remotePort: 80 });
    scope.defer(() => forward.close(), { label: "shared-web port-forward" });
    provide("sharedWebUrl", forward.url);
  },
});
