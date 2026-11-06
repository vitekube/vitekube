import type { KubernetesTarget } from "../core/kubernetes.ts";

declare module "vitest" {
  export interface ProvidedContext {
    vitekubeTarget: KubernetesTarget;
    vitekubeRoot: string;
  }
}
