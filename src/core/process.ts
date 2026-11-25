import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";

export type RunOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Written to the child's stdin, which is then closed. */
  input?: string | Uint8Array;
  /** Upper bound for the whole command. The child is killed when it passes. */
  timeoutMs: number;
  /** Cancels the command and ends the child. */
  signal?: AbortSignal;
  /** Keeps arguments and output out of every error this command produces. */
  private?: boolean;
  /**
   * Called with each complete line of output while the command runs, without its line ending. The result still
   * holds all of the output. Never called for private commands.
   */
  onLine?: (line: string, stream: "stdout" | "stderr") => void;
};

export type RunResult = {
  /** Real exit status, or null when the child was ended by a signal. */
  status: number | null;
  signal: NodeJS.Signals | null;
  /** Decoded as UTF-8 and untrimmed. Use the byte fields when exact bytes matter. */
  stdout: string;
  stderr: string;
  stdoutBytes: Buffer;
  stderrBytes: Buffer;
};

const KILL_GRACE_MS = 2_000;

/** Splits a stream into lines as it arrives. A last line without a line ending is passed on at the end. */
const forwardLines = (stream: Readable, onLine: (line: string) => void): void => {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  const send = (line: string): void => onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  const take = (text: string): void => {
    const lines = (pending + text).split("\n");
    pending = lines.pop() ?? "";
    lines.forEach(send);
  };
  stream.on("data", (chunk: Buffer) => take(decoder.write(chunk)));
  stream.once("end", () => {
    take(decoder.end());
    if (pending) send(pending);
  });
};

const ownedChildren = new Set<ChildProcess>();
let exitHookInstalled = false;

const track = (child: ChildProcess): void => {
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on("exit", () => killOwnedChildren("SIGKILL"));
  }
  ownedChildren.add(child);
  child.once("close", () => ownedChildren.delete(child));
};

/** Ends every child this process started and has not yet seen exit. Safe to call from a signal handler. */
export const killOwnedChildren = (signal: NodeJS.Signals = "SIGTERM"): void => {
  for (const child of ownedChildren) {
    child.kill(signal);
  }
};

const describeCommand = (command: string, args: readonly string[], isPrivate: boolean | undefined): string =>
  isPrivate ? `${command} (private command)` : [command, ...args].join(" ");

export class CommandStartError extends Error {
  override name = "CommandStartError";
  constructor(command: string, args: readonly string[], cause: Error, isPrivate?: boolean) {
    super(
      `Could not start ${describeCommand(command, args, isPrivate)}: ${isPrivate ? "start failed" : cause.message}`,
      {
        cause: isPrivate ? undefined : cause,
      }
    );
  }
}

export class CommandTimeoutError extends Error {
  override name = "CommandTimeoutError";
  constructor(command: string, args: readonly string[], timeoutMs: number, isPrivate?: boolean) {
    super(`Command timed out after ${timeoutMs}ms: ${describeCommand(command, args, isPrivate)}`);
  }
}

export class CommandCanceledError extends Error {
  override name = "CommandCanceledError";
  constructor(command: string, args: readonly string[], isPrivate?: boolean) {
    super(`Command canceled: ${describeCommand(command, args, isPrivate)}`);
  }
}

export class CommandFailedError extends Error {
  override name = "CommandFailedError";
  readonly status: number | null;
  /** Absent for private commands, because the output could contain what they protect. */
  readonly result?: RunResult;
  constructor(command: string, args: readonly string[], result: RunResult, isPrivate?: boolean) {
    const reason = result.status === null ? `signal ${result.signal}` : `status ${result.status}`;
    const output = isPrivate ? "" : `${result.stdout}\n${result.stderr}`.trim();
    super(`Command failed with ${reason}: ${describeCommand(command, args, isPrivate)}${output ? `\n${output}` : ""}`);
    this.status = result.status;
    this.result = isPrivate ? undefined : result;
  }
}

/**
 * Runs a command without blocking the event loop, so Vitest timeouts can still fire.
 * A nonzero exit is a result, not an error. Failure to start, timeouts and cancellation reject.
 */
export const run = (command: string, args: readonly string[], options: RunOptions): Promise<RunResult> => {
  const { promise, resolve, reject } = Promise.withResolvers<RunResult>();
  const isPrivate = options.private;

  if (options.signal?.aborted) {
    reject(new CommandCanceledError(command, args, isPrivate));
    return promise;
  }

  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  track(child);

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
  const { onLine } = options;
  if (onLine && !isPrivate) {
    forwardLines(child.stdout, (line) => onLine(line, "stdout"));
    forwardLines(child.stderr, (line) => onLine(line, "stderr"));
  }

  let ending: "timeout" | "canceled" | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  const end = (reason: "timeout" | "canceled"): void => {
    ending ??= reason;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
  };

  const timeoutTimer = setTimeout(() => end("timeout"), options.timeoutMs);
  const onAbort = (): void => end("canceled");
  options.signal?.addEventListener("abort", onAbort, { once: true });

  const finish = (): void => {
    clearTimeout(timeoutTimer);
    clearTimeout(killTimer);
    options.signal?.removeEventListener("abort", onAbort);
  };

  child.once("error", (error) => {
    finish();
    reject(new CommandStartError(command, args, error, isPrivate));
  });

  child.once("close", (status, signal) => {
    finish();
    if (ending === "timeout") {
      reject(new CommandTimeoutError(command, args, options.timeoutMs, isPrivate));
      return;
    }
    if (ending === "canceled") {
      reject(new CommandCanceledError(command, args, isPrivate));
      return;
    }
    const stdoutBytes = Buffer.concat(stdoutChunks);
    const stderrBytes = Buffer.concat(stderrChunks);
    resolve({
      status,
      signal,
      stdout: stdoutBytes.toString("utf8"),
      stderr: stderrBytes.toString("utf8"),
      stdoutBytes,
      stderrBytes,
    });
  });

  // A child can exit before reading its input; that surfaces through its status instead.
  child.stdin.on("error", () => {});
  child.stdin.end(options.input);

  return promise;
};

/** Like `run`, but any exit other than status 0 rejects with `CommandFailedError`. */
export const runChecked = async (command: string, args: readonly string[], options: RunOptions): Promise<RunResult> => {
  const result = await run(command, args, options);
  if (result.status !== 0) {
    throw new CommandFailedError(command, args, result, options.private);
  }
  return result;
};

export type BackgroundProcess = {
  child: ChildProcess;
  /** Resolves when the process has exited, whatever the reason. */
  exited: Promise<void>;
  isRunning: () => boolean;
  stop: () => Promise<void>;
};

/** Starts a long-lived child that this process owns. It is ended on process exit if not stopped first. */
export const startBackground = (
  command: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv } = {}
): BackgroundProcess => {
  const child = spawn(command, args, {
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  track(child);

  const { promise: exited, resolve } = Promise.withResolvers<void>();
  let running = true;
  const markExited = (): void => {
    running = false;
    resolve();
  };
  child.once("close", markExited);
  child.once("error", markExited);

  return {
    child,
    exited,
    isRunning: () => running,
    stop: async () => {
      if (!running) {
        return;
      }
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
      await exited;
      clearTimeout(killTimer);
    },
  };
};
