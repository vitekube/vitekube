import { styleText } from "node:util";

import { DefaultReporter, type TestModule, type Vitest } from "vitest/node";

import { formatDuration } from "../core/duration.ts";
import { RequireMatchingTests } from "./require-matching-tests.ts";

type DurationTask = { result?: { duration?: number } };

/**
 * Vitest's default output, with times people can read at a glance: `38.2s` instead of `38196ms`.
 * It also fails a run whose `-t` filter matched nothing, like `RequireMatchingTests`.
 */
export class K8sReporter extends DefaultReporter {
  private readonly filterCheck = new RequireMatchingTests();
  private startedAt = Date.now();

  constructor(...args: ConstructorParameters<typeof DefaultReporter>) {
    super(...args);
    /*
     * Replaces an internal Vitest method that its types mark private, so it has to be assigned rather than
     * overridden. If an upgrade renames it, the output returns to plain milliseconds and a unit test here fails.
     */
    Object.assign(this, {
      getDurationPrefix: (task: DurationTask): string => {
        const duration = task.result?.duration;
        if (duration == null) return "";
        const slow = duration > this.ctx.config.slowTestThreshold;
        return ` ${styleText(slow ? "yellow" : "green", formatDuration(duration))}`;
      },
    });
  }

  override onInit(vitest: Vitest): void {
    super.onInit(vitest);
    this.filterCheck.onInit(vitest);
    this.startedAt = Date.now();
  }

  override onTestRunEnd(...args: Parameters<DefaultReporter["onTestRunEnd"]>): void {
    super.onTestRunEnd(...args);
    // Vitest's own Duration line uses a private function, so the readable total is an extra line.
    this.log(`${styleText("dim", "     Total")}  ${formatDuration(Date.now() - this.startedAt)}`);
    this.filterCheck.onTestRunEnd(args[0] as readonly TestModule[]);
  }
}
