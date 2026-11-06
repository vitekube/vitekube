import { describe, expect, test } from "vitest";

import { decideExistingCluster, isLockLive, type RunLock } from "./lock.ts";

const lock: RunLock = { holder: "a", hostname: "here", pid: 42, expiresAt: 1_000 };

const at = (now: number, alive: boolean, hostname = "here") => ({ now, hostname, isProcessAlive: () => alive });

describe("isLockLive", () => {
  test("no lock is not live", () => {
    expect(isLockLive(undefined, at(0, true))).toBe(false);
  });

  test("an unexpired lock held by a running process is live", () => {
    expect(isLockLive(lock, at(500, true))).toBe(true);
  });

  test("an expired lock is not live", () => {
    expect(isLockLive(lock, at(1_000, true))).toBe(false);
  });

  test("a dead holder on this machine is not live before expiry", () => {
    expect(isLockLive(lock, at(500, false))).toBe(false);
  });

  test("a holder on another machine cannot be checked, so expiry decides", () => {
    expect(isLockLive(lock, at(500, false, "elsewhere"))).toBe(true);
  });
});

describe("decideExistingCluster", () => {
  const base = { name: "it", wantReuse: true, lockLive: false, unusableReason: undefined };

  test.each([true, false])("never touches a cluster it did not create (reuse=%s)", (wantReuse) => {
    expect(decideExistingCluster({ ...base, wantReuse, lifecycle: undefined })).toMatchObject({ action: "refuse" });
  });

  test("an active run is never replaced", () => {
    expect(decideExistingCluster({ ...base, lifecycle: "fresh", lockLive: true })).toEqual({ action: "busy" });
    expect(decideExistingCluster({ ...base, lifecycle: "reuse", lockLive: true })).toEqual({ action: "busy" });
  });

  test("an idle cluster from an interrupted fresh run is replaced", () => {
    expect(decideExistingCluster({ ...base, wantReuse: false, lifecycle: "fresh" })).toEqual({ action: "replace" });
  });

  test("a kept cluster is reused", () => {
    expect(decideExistingCluster({ ...base, lifecycle: "reuse" })).toEqual({ action: "reuse" });
  });

  test("a fresh run does not delete a kept cluster", () => {
    expect(decideExistingCluster({ ...base, wantReuse: false, lifecycle: "reuse" })).toMatchObject({
      action: "refuse",
    });
  });

  test("an unusable kept cluster stops the run and says why", () => {
    const decision = decideExistingCluster({ ...base, lifecycle: "reuse", unusableReason: "worker not restored" });

    expect(decision).toMatchObject({ action: "refuse" });
    expect(decision).toHaveProperty("message", expect.stringContaining("worker not restored"));
  });
});
