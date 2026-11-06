import { describe, expect, test } from "vitest";

import {
  CommandCanceledError,
  CommandFailedError,
  CommandStartError,
  CommandTimeoutError,
  killOwnedChildren,
  run,
  runChecked,
  startBackground,
} from "./process.ts";

const node = (script: string, input?: string) => run(process.execPath, ["-e", script], { input, timeoutMs: 10_000 });

describe("run", () => {
  test("keeps the real exit status and untrimmed output", async () => {
    const result = await node(`process.stdout.write(" out\\n"); process.stderr.write(" err\\n"); process.exit(7)`);

    expect(result).toMatchObject({ status: 7, signal: null, stdout: " out\n", stderr: " err\n" });
  });

  test("passes input through stdin", async () => {
    const result = await node(`process.stdin.pipe(process.stdout)`, "hello");

    expect(result.stdout).toBe("hello");
  });

  test("rejects clearly when the binary is missing", async () => {
    await expect(run("vitekube-no-such-binary", [], { timeoutMs: 1_000 })).rejects.toThrow(CommandStartError);
  });

  test("kills the child when the timeout passes", async () => {
    const startedAt = Date.now();

    await expect(run(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { timeoutMs: 100 })).rejects.toThrow(
      CommandTimeoutError
    );

    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  test("escalates to SIGKILL when the child ignores SIGTERM", async () => {
    const script = `process.on("SIGTERM", () => {}); console.log("ready"); setTimeout(() => {}, 60_000)`;

    await expect(run(process.execPath, ["-e", script], { timeoutMs: 300 })).rejects.toThrow(CommandTimeoutError);
  });

  test("does not block the event loop while the child runs", async () => {
    let timerFired = false;
    setTimeout(() => (timerFired = true), 20);

    await run(process.execPath, ["-e", "setTimeout(() => {}, 300)"], { timeoutMs: 5_000 });

    expect(timerFired).toBe(true);
  });
});

describe("exact bytes and cancellation", () => {
  test("keeps bytes that are not valid UTF-8", async () => {
    const result = await node(`process.stdout.write(Buffer.from([0xff, 0x00, 0x0a, 0x20]))`);

    expect([...result.stdoutBytes]).toEqual([0xff, 0x00, 0x0a, 0x20]);
  });

  test("passes binary input through unchanged", async () => {
    const input = Uint8Array.from([0xff, 0x00, 0x0a]);
    const result = await run(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], {
      input,
      timeoutMs: 10_000,
    });

    expect([...result.stdoutBytes]).toEqual([...input]);
  });

  test("a signal ends the child", async () => {
    const controller = new AbortController();
    const startedAt = Date.now();
    const running = run(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], {
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);

    await expect(running).rejects.toThrow(CommandCanceledError);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  test("an already canceled signal starts nothing", async () => {
    await expect(run("vitekube-no-such-binary", [], { timeoutMs: 1_000, signal: AbortSignal.abort() })).rejects.toThrow(
      CommandCanceledError
    );
  });
});

describe("private commands", () => {
  const marker = "SENSITIVE-MARKER-7f3a";

  const collect = (promise: Promise<unknown>) =>
    promise.then(
      () => undefined,
      (error: unknown) => error as Error
    );

  test("a failure hides arguments and output", async () => {
    const script = `console.log("${marker}"); console.error("${marker}"); process.exit(1)`;
    const error = (await collect(
      runChecked(process.execPath, ["-e", script, marker], { timeoutMs: 10_000, private: true })
    )) as CommandFailedError;

    expect(error).toBeInstanceOf(CommandFailedError);
    expect(error.status).toBe(1);
    expect(error.result).toBeUndefined();
    expect(JSON.stringify({ message: error.message, stack: error.stack })).not.toContain(marker);
  });

  test("a timeout hides arguments", async () => {
    const error = await collect(
      run(process.execPath, ["-e", "setTimeout(() => {}, 60_000)", marker], { timeoutMs: 50, private: true })
    );

    expect(error).toBeInstanceOf(CommandTimeoutError);
    expect(error?.message).not.toContain(marker);
  });

  test("a start failure hides arguments", async () => {
    const error = await collect(run("vitekube-no-such-binary", [marker], { timeoutMs: 1_000, private: true }));

    expect(error).toBeInstanceOf(CommandStartError);
    expect(error?.message).not.toContain(marker);
    expect(error?.cause).toBeUndefined();
  });
});

describe("background processes", () => {
  test("stop ends the child", async () => {
    const child = startBackground(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"]);
    expect(child.isRunning()).toBe(true);

    await child.stop();

    expect(child.isRunning()).toBe(false);
  });

  test("killOwnedChildren ends a running child", async () => {
    const child = startBackground(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"]);

    killOwnedChildren();
    await child.exited;

    expect(child.isRunning()).toBe(false);
  });
});

describe("runChecked", () => {
  test("rejects with the output on a nonzero exit", async () => {
    const error = await runChecked(process.execPath, ["-e", `console.error("boom"); process.exit(3)`], {
      timeoutMs: 10_000,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CommandFailedError);
    expect((error as CommandFailedError).status).toBe(3);
    expect((error as CommandFailedError).message).toContain("boom");
  });
});
