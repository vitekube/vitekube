import { createHash } from "node:crypto";
import { globSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export type StagePlanInput = {
  name: string;
  dependsOn?: readonly string[];
  images?: readonly string[];
};

export type StageDecision = {
  name: string;
  run: boolean;
  reason: string;
};

/** Stages run in declaration order, so a dependency has to be declared first. */
export const validateStages = (stages: readonly StagePlanInput[], imageNames: readonly string[]): void => {
  const seen = new Set<string>();
  for (const stage of stages) {
    if (seen.has(stage.name)) {
      throw new Error(`Stage "${stage.name}" is declared twice`);
    }
    for (const dependency of stage.dependsOn ?? []) {
      if (!seen.has(dependency)) {
        throw new Error(`Stage "${stage.name}" depends on "${dependency}", which must be declared before it`);
      }
    }
    for (const image of stage.images ?? []) {
      if (!imageNames.includes(image)) {
        throw new Error(`Stage "${stage.name}" uses image "${image}", which is not declared`);
      }
    }
    seen.add(stage.name);
  }
};

/** Decides what to run and why. A stage also runs when anything it depends on runs. */
export const planStages = (
  stages: readonly StagePlanInput[],
  fingerprints: Readonly<Record<string, string>>,
  recorded: Readonly<Record<string, string>>,
  { force = false }: { force?: boolean } = {}
): StageDecision[] => {
  const running = new Set<string>();
  return stages.map(({ name, dependsOn = [] }) => {
    const decide = (): { run: boolean; reason: string } => {
      if (force) return { run: true, reason: "a rebuild was requested" };
      if (recorded[name] === undefined) return { run: true, reason: "it has not completed on this cluster" };
      if (recorded[name] !== fingerprints[name]) return { run: true, reason: "its inputs changed" };
      const dependency = dependsOn.find((candidate) => running.has(candidate));
      if (dependency) return { run: true, reason: `it depends on ${dependency}, which is running` };
      return { run: false, reason: "unchanged" };
    };
    const decision = decide();
    if (decision.run) running.add(name);
    return { name, ...decision };
  });
};

const IGNORED_DIRECTORIES = new Set(["node_modules", ".git", "dist"]);

const filesUnder = (path: string): string[] => {
  if (statSync(path).isFile()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) return [];
    return filesUnder(join(path, entry.name));
  });
};

/**
 * Hashes file contents and paths relative to `rootDir`, so moving the checkout changes nothing.
 * A pattern matching no file is an error, because a typo would silently mean "never changes".
 */
export const fingerprintFiles = (rootDir: string, patterns: readonly string[]): string[] =>
  patterns.flatMap((pattern) => {
    const matches = globSync(pattern, { cwd: rootDir }).map((match) => resolve(rootDir, match));
    if (matches.length === 0) {
      throw new Error(`Nothing in ${rootDir} matches "${pattern}"`);
    }
    return matches
      .flatMap(filesUnder)
      .toSorted()
      .map((file) => `${relative(rootDir, file)}:${createHash("sha256").update(readFileSync(file)).digest("hex")}`);
  });

export const hashParts = (parts: readonly string[]): string =>
  createHash("sha256").update(parts.join("\n")).digest("hex");
