import { describe, expect } from "vitest";

import { waitFor } from "../src/core/index.ts";
import { test } from "../src/index.ts";
import { startWeb } from "./helpers.ts";
import { pod, WEB_IMAGE } from "./workloads.ts";

describe("NetworkPolicy", () => {
  test("the deny-all policy really blocks traffic", async ({ k8s, namespace }) => {
    await startWeb(k8s, namespace);
    await k8s.apply(namespace, pod("client", WEB_IMAGE, ["sleep", "600"]));
    await k8s.waitForPodReady({ namespace, name: "client" }, { timeoutMs: 120_000 });
    const probe = () => k8s.exec({ namespace, name: "client" }, ["wget", "-q", "-T", "2", "-O-", "http://web"]);

    // A new Service's name takes a moment to resolve, so even the starting point is awaited.
    const open = await waitFor(probe, (result) => result.status === 0, {
      timeoutMs: 30_000,
      describe: "the server to answer",
    });
    expect(open.stdout).toBe("ok\n");

    // Policies apply asynchronously too. The name still resolves, so this isn't a DNS failure: the connection is rejected.
    await k8s.applyFile(namespace, "fixtures/deny-all.yaml");
    await waitFor(probe, (result) => result.stderr.includes("can't connect to remote host"), {
      timeoutMs: 30_000,
      describe: "traffic to be blocked",
    });

    // Traffic returning shows the policy was what blocked it.
    await k8s.delete({ apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", namespace, name: "deny-all" });
    await waitFor(probe, (result) => result.status === 0, { timeoutMs: 30_000, describe: "traffic to return" });
  });
});
