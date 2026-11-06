export type DeferOptions = {
  /** Named in errors, so a failed or hung cleanup can be identified. */
  label?: string;
  timeoutMs?: number;
};

export class DisposalError extends AggregateError {
  override name = "DisposalError";
  constructor(errors: unknown[]) {
    const details = errors.map((error) => (error instanceof Error ? error.message : String(error)));
    super(errors, `${errors.length} cleanup(s) failed: ${details.join("; ")}`);
  }
}

export type Scope = {
  /** Register a cleanup immediately after acquiring what it releases. */
  defer: (cleanup: () => unknown, options?: DeferOptions) => void;
  /** Runs cleanups in reverse order, all of them even if some fail. Safe to call twice. */
  dispose: () => Promise<void>;
  [Symbol.asyncDispose]: () => Promise<void>;
};

const DEFAULT_CLEANUP_TIMEOUT_MS = 60_000;

const bounded = async (cleanup: () => unknown, label: string, timeoutMs: number): Promise<void> => {
  const { promise: expired, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => reject(new Error(`Cleanup "${label}" timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    await Promise.race([Promise.resolve().then(cleanup), expired]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Vitest does not time out fixture teardown, so each cleanup carries its own limit.
 * A hung cleanup is reported and the remaining ones still run.
 */
export const createScope = (options: { cleanupTimeoutMs?: number } = {}): Scope => {
  const cleanups: { cleanup: () => unknown; label: string; timeoutMs: number }[] = [];
  let disposal: Promise<void> | undefined;

  const dispose = (): Promise<void> => {
    disposal ??= (async () => {
      const errors: unknown[] = [];
      for (const { cleanup, label, timeoutMs } of cleanups.reverse()) {
        try {
          await bounded(cleanup, label, timeoutMs);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) {
        throw new DisposalError(errors);
      }
    })();
    return disposal;
  };

  return {
    defer: (cleanup, deferOptions = {}) => {
      if (disposal) {
        throw new Error("Cannot defer a cleanup on a scope that is already disposed");
      }
      cleanups.push({
        cleanup,
        label: deferOptions.label ?? `cleanup ${cleanups.length + 1}`,
        timeoutMs: deferOptions.timeoutMs ?? options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS,
      });
    },
    dispose,
    [Symbol.asyncDispose]: dispose,
  };
};

/**
 * Runs `body` with a scope and always disposes it. If `body` fails, its error is the one thrown,
 * and cleanup failures are logged. A failed cleanup must not replace the failure that explains the run.
 */
export const withScope = async <T>(
  body: (scope: Scope) => Promise<T>,
  options?: { cleanupTimeoutMs?: number }
): Promise<T> => {
  const scope = createScope(options);
  let result: T;
  try {
    result = await body(scope);
  } catch (primary) {
    await scope.dispose().catch((error: unknown) => {
      console.error(`[vitekube] cleanup also failed: ${String(error)}`);
    });
    throw primary;
  }
  await scope.dispose();
  return result;
};
