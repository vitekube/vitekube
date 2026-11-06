import type { Reporter, TestModule, Vitest } from "vitest/node";

/**
 * Vitest exits 0 when `-t` matches nothing, so a typo in a filter looks like a pass after a full provision.
 * This reporter fails that run. Runs without a name filter are unaffected, so a suite that is
 * entirely `test.skip` still passes.
 */
export class RequireMatchingTests implements Reporter {
  private vitest: Vitest | undefined;

  onInit(vitest: Vitest): void {
    this.vitest = vitest;
  }

  onTestRunEnd(testModules: readonly TestModule[]): void {
    const pattern = this.vitest?.config.testNamePattern;
    // No modules means the run failed before collecting tests, and that failure is already reported.
    if (!pattern || testModules.length === 0) {
      return;
    }

    const executed = testModules.some((testModule) =>
      [...testModule.children.allTests()].some((testCase) => testCase.result().state !== "skipped")
    );
    if (!executed) {
      console.error(`[vitekube] no test matched the name filter ${String(pattern)}`);
      process.exitCode = 1;
    }
  }
}
