import { test } from "vitekube";
import { expect } from "vitest";

test("the web server answers", async ({ k8s, namespace }) => {
  await k8s.applyFile(namespace, "web.yaml");
  await k8s.waitForRollout({ namespace, name: "web" }, { timeoutMs: 120_000 });

  await using web = await k8s.portForward({
    namespace,
    resource: "service/web",
    remotePort: 80,
  });

  expect((await fetch(web.url)).status).toBe(200);
});
