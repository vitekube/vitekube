import { test } from "vitekube";
import { expect } from "vitest";

const web = {
  apiVersion: "v1",
  kind: "List",
  items: [
    {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "web" },
      spec: {
        selector: { matchLabels: { app: "web" } },
        template: {
          metadata: { labels: { app: "web" } },
          spec: { containers: [{ name: "web", image: "nginx:1.29-alpine", ports: [{ containerPort: 80 }] }] },
        },
      },
    },
    {
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: "web" },
      spec: { selector: { app: "web" }, ports: [{ port: 80 }] },
    },
  ],
};

test("the web server answers", async ({ k8s, namespace }) => {
  await k8s.apply(namespace, web);
  await k8s.waitForRollout({ namespace, name: "web" }, { timeoutMs: 120_000 });

  await using forward = await k8s.portForward({ namespace, resource: "service/web", remotePort: 80 });
  const response = await fetch(forward.url);

  expect(response.status).toBe(200);
});
