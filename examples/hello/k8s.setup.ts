import { defineK8sGlobalSetup } from "vitekube/node";

export default defineK8sGlobalSetup({
  cluster: { provider: "k3d", name: "vitekube-hello" },
});
