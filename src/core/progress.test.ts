import { afterEach, describe, expect, test, vi } from "vitest";

import { buildProgressLine, HEARTBEAT_MS, k3dProgressLine, relayLines, withProgress } from "./progress.ts";

describe("withProgress", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("says the step is still running every heartbeat until it settles", async () => {
    vi.useFakeTimers();
    const printed: string[] = [];
    const { promise, resolve } = Promise.withResolvers<string>();
    const result = withProgress(
      "building image api:local",
      () => promise,
      (message) => printed.push(message)
    );

    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
    resolve("done");
    await expect(result).resolves.toBe("done");
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);

    expect(printed).toEqual(["still building image api:local (15.0s)", "still building image api:local (30.0s)"]);
  });

  test("stops when the step fails, and passes the failure on", async () => {
    vi.useFakeTimers();
    const printed: string[] = [];

    await expect(
      withProgress(
        "installing",
        () => Promise.reject(new Error("boom")),
        (message) => printed.push(message)
      )
    ).rejects.toThrow("boom");
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);

    expect(printed).toEqual([]);
  });
});

describe("relayLines", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const relay = (lines: readonly string[], select: (line: string) => string | undefined) => {
    const printed: string[] = [];
    const onLine = relayLines("k3d", select, (message) => printed.push(message))!;
    for (const line of lines) onLine(line, "stderr");
    return printed;
  };

  test("prints selected lines once, without color codes, shortening long ones", () => {
    const long = "x".repeat(300);

    const printed = relay(
      ["\u001b[36mINFO\u001b[0m[0000] a   ", "skip", "INFO[0001] a", `INFO[0002] ${long}`],
      (line) => (line === "skip" ? undefined : line.replace(/^INFO\[\d+\] /, ""))
    );

    expect(printed).toEqual(["  k3d: a", `  k3d: ${"x".repeat(159)}…`]);
  });

  test("prints every non-empty line unchanged in verbose mode", () => {
    vi.stubEnv("VITEKUBE_VERBOSE", "1");

    expect(relay(["one", "", "one", "two"], () => undefined)).toEqual(["  k3d: one", "  k3d: one", "  k3d: two"]);
  });
});

describe("k3dProgressLine", () => {
  test.each([
    ["INFO[0006] Starting cluster 'it'", "Starting cluster 'it'"],
    ["WARN[0002] No node filter specified", "warning: No node filter specified"],
    ["FATA[0000] failed to get cluster it", "error: failed to get cluster it"],
    ["INFO[0000]", undefined],
    ["INFO[0015] You can now use it like this:", undefined],
    ["some other output", undefined],
  ])("%j", (line, expected) => {
    expect(k3dProgressLine(line)).toBe(expected);
  });
});

describe("buildProgressLine", () => {
  test.each([
    ["#6 [2/2] COPY message.txt /message.txt", "[2/2] COPY message.txt /message.txt"],
    ["#9 [builder 3/5] RUN pnpm install", "[builder 3/5] RUN pnpm install"],
    [
      `#5 [1/2] FROM docker.io/library/alpine:3.24@sha256:${"f".repeat(64)}`,
      "[1/2] FROM docker.io/library/alpine:3.24",
    ],
    ["#1 [internal] load build definition from Dockerfile", undefined],
    ["#6 DONE 0.0s", undefined],
    ["#9 3.214 Progress: resolved 120", undefined],
    ["#7 exporting to image", undefined],
  ])("%j", (line, expected) => {
    expect(buildProgressLine(line)).toBe(expected);
  });
});
