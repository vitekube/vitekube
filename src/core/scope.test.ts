import { describe, expect, test } from "vitest";

import { createScope, DisposalError, withScope } from "./scope.ts";

describe("createScope", () => {
  test("disposes in reverse order", async () => {
    const order: number[] = [];
    const scope = createScope();
    scope.defer(() => order.push(1));
    scope.defer(() => order.push(2));

    await scope.dispose();

    expect(order).toEqual([2, 1]);
  });

  test("runs every cleanup and reports all failures", async () => {
    const order: string[] = [];
    const scope = createScope();
    scope.defer(() => order.push("first"));
    scope.defer(() => {
      throw new Error("A");
    });
    scope.defer(() => Promise.reject(new Error("B")));

    const error = await scope.dispose().catch((caught: unknown) => caught as DisposalError);

    expect(error).toBeInstanceOf(DisposalError);
    expect((error as DisposalError).message).toContain("B");
    expect((error as DisposalError).message).toContain("A");
    expect(order).toEqual(["first"]);
  });

  test("a hung cleanup hits its bound and later ones still run", async () => {
    const order: string[] = [];
    const scope = createScope();
    scope.defer(() => order.push("earlier"));
    scope.defer(() => new Promise(() => {}), { label: "stuck forward", timeoutMs: 20 });

    await expect(scope.dispose()).rejects.toThrow('"stuck forward" timed out');
    expect(order).toEqual(["earlier"]);
  });

  test("disposing twice runs cleanups once", async () => {
    let calls = 0;
    const scope = createScope();
    scope.defer(() => (calls += 1));

    await scope.dispose();
    await scope.dispose();

    expect(calls).toBe(1);
  });

  test("works with await using, and restores when the block throws", async () => {
    let restored = false;

    await expect(
      (async () => {
        await using scope = createScope();
        scope.defer(() => (restored = true));
        throw new Error("primary");
      })()
    ).rejects.toThrow("primary");

    expect(restored).toBe(true);
  });

  test("refuses a cleanup registered after disposal", async () => {
    const scope = createScope();
    await scope.dispose();

    expect(() => scope.defer(() => {})).toThrow("already disposed");
  });
});

describe("withScope", () => {
  test("keeps the primary failure when cleanup also fails", async () => {
    await expect(
      withScope(async (scope) => {
        scope.defer(() => {
          throw new Error("cleanup failed");
        });
        throw new Error("primary");
      })
    ).rejects.toThrow("primary");
  });

  test("cleans up after partial acquisition", async () => {
    const released: string[] = [];

    await expect(
      withScope(async (scope) => {
        scope.defer(() => released.push("first resource"));
        throw new Error("second resource failed to start");
      })
    ).rejects.toThrow("second resource");

    expect(released).toEqual(["first resource"]);
  });

  test("reports a cleanup failure when the body succeeded", async () => {
    await expect(
      withScope(async (scope) => {
        scope.defer(() => {
          throw new Error("cleanup failed");
        });
      })
    ).rejects.toThrow("cleanup failed");
  });
});
