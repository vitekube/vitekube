import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { fingerprintFiles, hashParts, planStages, validateStages } from "./environment-plan.ts";

const stages = [
  { name: "dependencies" },
  { name: "migrations", dependsOn: ["dependencies"] },
  { name: "api", dependsOn: ["migrations"] },
  { name: "vector" },
];
const fingerprints = { dependencies: "d", migrations: "m", api: "a", vector: "v" };
const runningNames = (decisions: ReturnType<typeof planStages>): string[] =>
  decisions.filter((decision) => decision.run).map((decision) => decision.name);

describe("planStages", () => {
  it("runs everything on a new cluster", () => {
    expect(runningNames(planStages(stages, fingerprints, {}))).toEqual(["dependencies", "migrations", "api", "vector"]);
  });

  it("skips everything when nothing changed", () => {
    expect(runningNames(planStages(stages, fingerprints, fingerprints))).toEqual([]);
  });

  it("runs a changed stage and what depends on it, and nothing else", () => {
    const decisions = planStages(stages, fingerprints, { ...fingerprints, migrations: "old" });

    expect(runningNames(decisions)).toEqual(["migrations", "api"]);
    expect(decisions.find((decision) => decision.name === "api")?.reason).toBe(
      "it depends on migrations, which is running"
    );
  });

  it("runs a stage whose record was cleared, so a failed stage is retried", () => {
    const { api: _api, ...recorded } = fingerprints;

    expect(runningNames(planStages(stages, fingerprints, recorded))).toEqual(["api"]);
  });

  it("runs everything when forced", () => {
    expect(runningNames(planStages(stages, fingerprints, fingerprints, { force: true }))).toHaveLength(4);
  });
});

describe("validateStages", () => {
  it("rejects a dependency declared later, because stages run in order", () => {
    expect(() => validateStages([{ name: "a", dependsOn: ["b"] }, { name: "b" }], [])).toThrow(/declared before/);
  });

  it("rejects duplicate names and undeclared images", () => {
    expect(() => validateStages([{ name: "a" }, { name: "a" }], [])).toThrow(/declared twice/);
    expect(() => validateStages([{ name: "a", images: ["missing"] }], [])).toThrow(/not declared/);
  });
});

describe("fingerprintFiles", () => {
  const directories: string[] = [];
  const directoryWith = (files: Record<string, string>): string => {
    const directory = mkdtempSync(join(tmpdir(), "vitekube-fingerprint-"));
    directories.push(directory);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(directory, path, ".."), { recursive: true });
      writeFileSync(join(directory, path), content);
    }
    return directory;
  };

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  const fingerprint = (root: string, patterns: string[]): string => hashParts(fingerprintFiles(root, patterns));

  it("depends on content, and not on the checkout's location", () => {
    const first = directoryWith({ "chart/a.yaml": "one" });
    const moved = directoryWith({ "chart/a.yaml": "one" });
    const changed = directoryWith({ "chart/a.yaml": "two" });

    expect(fingerprint(first, ["chart"])).toBe(fingerprint(moved, ["chart"]));
    expect(fingerprint(first, ["chart"])).not.toBe(fingerprint(changed, ["chart"]));
  });

  it("notices a renamed file and supports globs", () => {
    const first = directoryWith({ "db/a.sql": "x" });
    const renamed = directoryWith({ "db/b.sql": "x" });

    expect(fingerprint(first, ["db/*.sql"])).not.toBe(fingerprint(renamed, ["db/*.sql"]));
  });

  it("ignores node_modules", () => {
    const first = directoryWith({ "app/a.ts": "x" });
    const installed = directoryWith({ "app/a.ts": "x", "app/node_modules/dep/index.js": "y" });

    expect(fingerprint(first, ["app"])).toBe(fingerprint(installed, ["app"]));
  });

  it("rejects a pattern that matches nothing, which would otherwise mean it never changes", () => {
    expect(() => fingerprintFiles(directoryWith({ "a.txt": "x" }), ["missing/**"])).toThrow(/matches "missing/);
  });
});
