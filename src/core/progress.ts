import { formatDuration } from "./duration.ts";
import type { RunOptions } from "./process.ts";

/** How often a step that prints nothing of its own says that it is still running. */
export const HEARTBEAT_MS = 15_000;

/** Relayed lines longer than this are shortened, except in verbose mode. */
const MAX_LINE_LENGTH = 160;

export const log = (message: string): void => console.log(`[vitekube] ${message}`);

/** `VITEKUBE_VERBOSE=1` relays every output line of the commands that setup runs. */
export const isVerbose = (): boolean => process.env.VITEKUBE_VERBOSE === "1";

/** Prints `still <label> (15.0s)` every `HEARTBEAT_MS` until `work` settles. */
export const withProgress = async <T>(
  label: string,
  work: () => Promise<T>,
  print: (message: string) => void = log
): Promise<T> => {
  const startedAt = Date.now();
  const timer = setInterval(() => print(`still ${label} (${formatDuration(Date.now() - startedAt)})`), HEARTBEAT_MS);
  timer.unref();
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
};

// oxlint-disable-next-line no-control-regex -- matches terminal color codes.
const ANSI = /\u001b\[[0-9;]*m/g;

export const stripAnsi = (text: string): string => text.replace(ANSI, "");

const shorten = (line: string): string =>
  line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH - 1)}…` : line;

/**
 * Builds the `onLine` option for `run`. `select` turns an output line into the text worth showing, or
 * `undefined` to drop it. A line already shown is dropped too, because BuildKit repeats a step's first line
 * whenever output from parallel steps interleaves. In verbose mode every non-empty line is shown as it is.
 */
export const relayLines = (
  prefix: string,
  select: (line: string) => string | undefined,
  print: (message: string) => void = log
): RunOptions["onLine"] => {
  const verbose = isVerbose();
  const seen = new Set<string>();
  return (raw) => {
    const line = stripAnsi(raw).trimEnd();
    if (verbose) {
      if (line) print(`  ${prefix}: ${line}`);
      return;
    }
    const shown = select(line);
    if (shown !== undefined && !seen.has(shown)) {
      seen.add(shown);
      print(`  ${prefix}: ${shorten(shown)}`);
    }
  };
};

/** A k3d log line such as `INFO[0012] Starting servers...`, without the level and timestamp. */
export const k3dProgressLine = (line: string): string | undefined => {
  const match = /^(INFO|WARN|ERRO|FATA)\[\d+\]\s*(.*)$/.exec(line);
  if (!match) return undefined;
  const [, level, message] = match;
  // The usage hint that ends `k3d cluster create` is followed by a command printed without a level.
  if (!message || message.startsWith("You can now use it like this")) return undefined;
  return level === "INFO" ? message : `${level === "WARN" ? "warning" : "error"}: ${message}`;
};

/**
 * The start of each Dockerfile step in BuildKit's plain progress, such as `[builder 3/5] RUN pnpm install`.
 * BuildKit's own bookkeeping steps, and output from inside a step, are dropped.
 */
export const buildProgressLine = (line: string): string | undefined => {
  const match = /^#\d+ (\[[^\]]+\] .*)$/.exec(line);
  if (!match || match[1]!.startsWith("[internal]")) return undefined;
  return match[1]!.replace(/@sha256:[0-9a-f]{64}/, "");
};
