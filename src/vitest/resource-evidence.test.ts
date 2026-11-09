import type { CoreV1Event, V1Pod } from "@kubernetes/client-node";
import { describe, expect, test, vi } from "vitest";

import { createEvidence } from "./evidence.ts";

const fixture = () => {
  const pod: V1Pod = {
    metadata: { name: "worker-1", namespace: "shared", uid: "selected-uid" },
    spec: {
      initContainers: [{ name: "init" }],
      containers: [{ name: "worker", env: [{ name: "SECRET", value: "spec-secret" }] }, { name: "sidecar" }],
    },
    status: {
      phase: "Running",
      containerStatuses: [{ name: "worker", restartCount: 1, ready: true, image: "worker", imageID: "worker:1" }],
    },
  };
  const events: CoreV1Event[] = [
    {
      metadata: {},
      involvedObject: { kind: "Pod", name: "worker-1", uid: "selected-uid" },
      type: "Warning",
      reason: "BackOff",
      message: "selected event",
    },
    {
      metadata: {},
      involvedObject: { kind: "Pod", name: "worker-1", uid: "older-pod-uid" },
      message: "same name but old identity",
    },
    { metadata: {}, involvedObject: { kind: "Pod", name: "other", uid: "other-uid" }, message: "unrelated event" },
    { metadata: {}, involvedObject: { kind: "Deployment", name: "worker" }, message: "controller event" },
  ];
  const client = {
    list: vi.fn().mockImplementation(async ({ kind }: { kind: string }) => (kind === "Pod" ? [pod] : events)),
    logs: vi
      .fn()
      .mockImplementation(
        async (_ref: unknown, options: { container: string; previous: boolean }) =>
          `${options.container}${options.previous ? " previous" : ""} output`
      ),
  };
  return { client, evidence: createEvidence(client), pod, events };
};

describe("resource evidence", () => {
  test("is lazy and filters selected Pod events by UID, not by name", async () => {
    const { client, evidence } = fixture();
    evidence.watchResources({ namespace: "shared", labelSelector: "app=worker" });
    expect(client.list).not.toHaveBeenCalled();
    expect(client.logs).not.toHaveBeenCalled();

    const captured = await evidence.capture();

    expect(client.list).toHaveBeenCalledWith(
      { apiVersion: "v1", kind: "Pod", namespace: "shared" },
      { labelSelector: "app=worker" }
    );
    expect(captured).toContain("selected event");
    expect(captured).toContain("worker-1");
    expect(captured).not.toContain("same name but old identity");
    expect(captured).not.toContain("unrelated event");
    expect(captured).not.toContain("controller event");
    expect(captured).not.toContain("spec-secret");
  });

  test("without a selector it includes namespace events, including controller events", async () => {
    const { evidence } = fixture();
    evidence.watchResources({ namespace: "shared" });

    expect(await evidence.capture()).toContain("controller event");
  });

  test("collects each init/application container and previous logs for observed restarts", async () => {
    const { client, evidence } = fixture();
    evidence.watchResources({ namespace: "shared", tailLines: 17 });

    const captured = await evidence.capture();

    expect(client.logs).toHaveBeenCalledTimes(4);
    expect(client.logs).toHaveBeenCalledWith(
      { namespace: "shared", name: "worker-1" },
      { container: "worker", tailLines: 17, previous: true }
    );
    expect(captured).toContain("worker-1/init:\ninit output");
    expect(captured).toContain("worker-1/worker (previous):\nworker previous output");
    expect(captured).toContain("worker-1/sidecar:\nsidecar output");
  });

  test("previous logs can be disabled", async () => {
    const { client, evidence } = fixture();
    evidence.watchResources({ namespace: "shared", previous: false });

    await evidence.capture();

    expect(client.logs).toHaveBeenCalledTimes(3);
    expect(client.logs.mock.calls.every(([, options]) => !options.previous)).toBe(true);
  });

  test("includes ephemeral container logs", async () => {
    const { client, evidence, pod } = fixture();
    pod.spec!.ephemeralContainers = [{ name: "debugger" }];
    evidence.watchResources({ namespace: "shared" });

    expect(await evidence.capture()).toContain("worker-1/debugger:\ndebugger output");
    expect(client.logs).toHaveBeenCalledWith(
      { namespace: "shared", name: "worker-1" },
      { container: "debugger", tailLines: 100, previous: false }
    );
  });

  test("restriction prevents all log reads but still captures Pod state and events", async () => {
    const { client, evidence } = fixture();
    evidence.watchResources({ namespace: "shared" });
    evidence.restrict();

    const captured = await evidence.capture();

    expect(client.logs).not.toHaveBeenCalled();
    expect(captured).toContain("Running");
    expect(captured).toContain("selected event");
    expect(captured).not.toContain("--- logs");
  });

  test("redacts log contents and per-container read failures", async () => {
    const { client, evidence } = fixture();
    client.logs
      .mockRejectedValueOnce(new Error("failed with log-secret"))
      .mockResolvedValue("output contains log-secret");
    evidence.watchResources({ namespace: "shared" });
    evidence.markSensitive("log-secret");

    const captured = await evidence.capture();

    expect(captured).toContain("could not read: Error: failed with ***");
    expect(captured).toContain("output contains ***");
    expect(captured).not.toContain("log-secret");
  });

  test("reports inaccessible resources rather than silently omitting them", async () => {
    const { client, evidence } = fixture();
    client.list.mockRejectedValue(new Error("Forbidden"));
    evidence.watchResources({ namespace: "shared" });

    expect(await evidence.capture()).toContain("could not collect: Error: Forbidden");
  });

  test("captures fresh state each time and identifies terminating Pods", async () => {
    const { evidence, pod } = fixture();
    evidence.watchResources({ namespace: "shared" });
    expect(await evidence.capture()).not.toContain("(terminating)");
    pod.metadata!.deletionTimestamp = new Date();

    expect(await evidence.capture()).toContain("worker-1 (terminating)");
  });

  test("an empty selection does not include events from other Pods", async () => {
    const { client, evidence, events } = fixture();
    client.list.mockImplementation(async ({ kind }: { kind: string }) => (kind === "Pod" ? [] : events));
    evidence.watchResources({ namespace: "shared", labelSelector: "app=missing" });

    const captured = await evidence.capture();

    expect(client.logs).not.toHaveBeenCalled();
    expect(captured).not.toContain("selected event");
    expect(captured).not.toContain("unrelated event");
  });
});
