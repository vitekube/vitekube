import { readFileSync } from "node:fs";

import { test } from "vitekube";
import type { V1ConfigMap } from "@kubernetes/client-node";
import { expect } from "vitest";

test("the cluster matches the current files", async ({ k8s }) => {
  const seed = await k8s.get<V1ConfigMap>({ apiVersion: "v1", kind: "ConfigMap", namespace: "default", name: "seed" });
  expect(seed?.data?.seed).toBe(readFileSync("inputs/seed.txt", "utf8"));

  const logs = await k8s.logs({ namespace: "default", name: "deployment/example-app" });
  expect(logs.trim()).toBe(readFileSync("app/message.txt", "utf8").trim());
});
