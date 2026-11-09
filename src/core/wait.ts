import { setTimeout as delay } from "node:timers/promises";

export type WaitOptions = {
  timeoutMs: number;
  intervalMs?: number;
  signal?: AbortSignal;
};

export class WaitTimeoutError extends Error {
  override name = "WaitTimeoutError";
  readonly lastState: unknown;
  constructor(what: string, timeoutMs: number, lastState: unknown) {
    const state = lastState === undefined ? "" : ` Last state: ${JSON.stringify(lastState)}`;
    super(`Timed out after ${timeoutMs}ms waiting for ${what}.${state}`);
    this.lastState = lastState;
  }
}

export type WaitForOptions<T> = WaitOptions & {
  /** Named in the timeout error. */
  describe: string;
  /**
   * Produces what the timeout error reports. It is opt-in because observed values can hold secrets,
   * such as a Pod's environment, so return only fields that are safe to print.
   */
  summarize?: (value: T) => unknown;
};

/**
 * Polls `read` until `predicate` accepts the value, and returns that value.
 * An error from `read` or `predicate` ends the wait: broken access must not look like "not ready yet",
 * and a predicate can throw to report a terminal failure immediately.
 */
export const waitFor = async <T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  options: WaitForOptions<T>
): Promise<T> => {
  const deadline = Date.now() + options.timeoutMs;
  const intervalMs = options.intervalMs ?? 1_000;

  while (true) {
    options.signal?.throwIfAborted();
    const value = await read();
    if (predicate(value)) {
      return value;
    }
    if (Date.now() + intervalMs > deadline) {
      throw new WaitTimeoutError(options.describe, options.timeoutMs, options.summarize?.(value));
    }
    await delay(intervalMs, undefined, { signal: options.signal });
  }
};
