import { describe, expect, test } from "vitest";

import { waitFor, WaitTimeoutError } from "./wait.ts";

const sequence = <T>(...values: T[]) => {
  let index = 0;
  return async (): Promise<T> => values[Math.min(index++, values.length - 1)] as T;
};

const options = { timeoutMs: 100, intervalMs: 1, describe: "the thing" };

describe("waitFor", () => {
  test("returns the observed value that was accepted", async () => {
    await expect(waitFor(sequence(1, 2, 3), (value) => value === 3, options)).resolves.toBe(3);
  });

  test("a failed read ends the wait instead of being retried", async () => {
    let calls = 0;
    const forbidden = async (): Promise<number> => {
      calls += 1;
      throw new Error("Forbidden");
    };

    await expect(waitFor(forbidden, () => true, options)).rejects.toThrow("Forbidden");
    expect(calls).toBe(1);
  });

  test("a predicate can end the wait with a terminal failure", async () => {
    const terminal = (): boolean => {
      throw new Error("terminal");
    };

    await expect(waitFor(sequence(1), terminal, { ...options, timeoutMs: 60_000 })).rejects.toThrow("terminal");
  });

  test("a timeout reports the summary and not the raw value", async () => {
    const error = await waitFor(sequence({ phase: "Pending", secret: "hunter2" }), () => false, {
      ...options,
      summarize: ({ phase }) => ({ phase }),
    }).catch((caught: unknown) => caught as WaitTimeoutError);

    expect(error).toBeInstanceOf(WaitTimeoutError);
    expect((error as WaitTimeoutError).lastState).toEqual({ phase: "Pending" });
    expect((error as WaitTimeoutError).message).toContain("Pending");
    expect((error as WaitTimeoutError).message).not.toContain("hunter2");
  });

  test("a timeout without a summary reports no state", async () => {
    const error = await waitFor(sequence("hunter2"), () => false, options).catch((caught: Error) => caught);

    expect((error as Error).message).not.toContain("hunter2");
  });

  test("a signal stops the wait", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    await expect(
      waitFor(sequence(1), () => false, {
        timeoutMs: 60_000,
        intervalMs: 10_000,
        describe: "the thing",
        signal: controller.signal,
      })
    ).rejects.toThrow();
  });
});
