import type { ManagedLifecycle } from "./k3d.ts";

export type RunLock = {
  holder: string;
  hostname: string;
  pid: number;
  expiresAt: number;
};

export type LockEnvironment = {
  now: number;
  hostname: string;
  isProcessAlive: (pid: number) => boolean;
};

/** A holder on this machine whose process is gone is stale at once, so a killed run need not wait for expiry. */
export const isLockLive = (lock: RunLock | undefined, environment: LockEnvironment): boolean => {
  if (!lock || lock.expiresAt <= environment.now) {
    return false;
  }
  return lock.hostname !== environment.hostname || environment.isProcessAlive(lock.pid);
};

export const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

export type ExistingClusterDecision =
  | { action: "refuse"; message: string }
  | { action: "busy" }
  | { action: "replace" }
  | { action: "reuse" };

/** What to do about a k3d cluster that already has this name. Deletion needs proof that it is ours and idle. */
export const decideExistingCluster = (input: {
  name: string;
  lifecycle: ManagedLifecycle | undefined;
  wantReuse: boolean;
  lockLive: boolean;
  unusableReason: string | undefined;
}): ExistingClusterDecision => {
  const { name, lifecycle, wantReuse, lockLive, unusableReason } = input;
  const deleteHint = `To remove it: k3d cluster delete ${name}`;

  if (!lifecycle) {
    return {
      action: "refuse",
      message: `k3d cluster "${name}" exists but was not created by vitekube, so it will not be used or deleted. ${deleteHint}`,
    };
  }
  if (lockLive) {
    return { action: "busy" };
  }
  if (lifecycle === "fresh") {
    return { action: "replace" };
  }
  if (!wantReuse) {
    return {
      action: "refuse",
      message: `k3d cluster "${name}" is a kept cluster, and this run asked for a fresh one, so it will not be deleted. ${deleteHint}`,
    };
  }
  if (unusableReason) {
    return { action: "refuse", message: `k3d cluster "${name}" is marked unusable: ${unusableReason}. ${deleteHint}` };
  }
  return { action: "reuse" };
};
