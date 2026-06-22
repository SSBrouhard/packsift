#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { analyze } from "./analyze.js";
import { analyzeBatch, classifyTransitions } from "./batch.js";
import { formatBatchHuman, formatHuman } from "./format.js";
import { parseLockfile } from "./lockfile.js";
import { fetchArtifacts } from "./registry.js";
import { assertSamePackage, parsePackageSpec } from "./spec.js";
import { type BatchReport } from "./types.js";

interface CliOptions {
  json: boolean;
  diff: boolean;
  registry: string;
  keep: boolean;
  positionals: string[];
}

export interface BatchCliOptions extends CliOptions {
  concurrency: number;
  oldLockfile: string;
  newLockfile: string;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "batch") {
    await runBatch(parseBatchArgs(argv.slice(1)));
    return;
  }

  const options = parseArgs(argv);
  if (options.positionals.length !== 2) {
    throw new Error("Expected exactly two positional args: sift <name>@<old> <name>@<new>");
  }

  const oldSpec = parsePackageSpec(options.positionals[0]);
  const newSpec = parsePackageSpec(options.positionals[1]);
  assertSamePackage(oldSpec, newSpec);

  const fetched = await fetchArtifacts(oldSpec, newSpec, { registry: options.registry, keep: options.keep });
  try {
    const report = await analyze(
      {
        packageName: oldSpec.name,
        oldVersion: oldSpec.version,
        newVersion: newSpec.version,
        oldDir: fetched.oldArtifacts.extractDir,
        newDir: fetched.newArtifacts.extractDir,
        oldRegistryManifest: fetched.oldArtifacts.registryManifest,
        newRegistryManifest: fetched.newArtifacts.registryManifest,
        integrityWarnings: fetched.integrityWarnings
      },
      { includeDiffs: options.diff }
    );

    if (options.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(formatHuman(report, options.diff));
    }
  } finally {
    await fetched.cleanup();
  }
}

async function runBatch(options: BatchCliOptions): Promise<void> {
  const oldVersions = await parseLockfile(options.oldLockfile);
  const newVersions = await parseLockfile(options.newLockfile);
  const classified = classifyTransitions(oldVersions, newVersions);
  const report = await analyzeBatch(classified, {
    registry: options.registry,
    keep: options.keep,
    includeDiffs: options.diff,
    concurrency: options.concurrency
  });

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(formatBatchHuman(report));
  }
  applyBatchExitCode(report);
}

export function applyBatchExitCode(report: Pick<BatchReport, "errors">): void {
  if (report.errors.length > 0) process.exitCode = 1;
}

export function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    json: false,
    diff: false,
    registry: "https://registry.npmjs.org",
    keep: false,
    positionals: []
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--diff") options.diff = true;
    else if (arg === "--keep") options.keep = true;
    else if (arg === "--registry") {
      const value = args[index + 1];
      if (!value) throw new Error("--registry requires a URL");
      options.registry = value;
      index += 1;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      options.positionals.push(arg);
    }
  }

  return options;
}

export function parseBatchArgs(args: string[]): BatchCliOptions {
  const options: CliOptions = {
    json: false,
    diff: false,
    registry: "https://registry.npmjs.org",
    keep: false,
    positionals: []
  };
  let concurrency = 4;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--diff") {
      options.diff = true;
    } else if (arg === "--keep") {
      options.keep = true;
    } else if (arg === "--registry") {
      const value = args[index + 1];
      if (!value) throw new Error("--registry requires a URL");
      options.registry = value;
      index += 1;
    } else if (arg === "--concurrency") {
      const value = args[index + 1];
      if (!value) throw new Error("--concurrency requires a positive integer");
      concurrency = parseConcurrency(value);
      index += 1;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      options.positionals.push(arg);
    }
  }

  if (options.positionals.length !== 2) {
    throw new Error("Expected exactly two lockfile paths: sift batch <old-package-lock.json> <new-package-lock.json>");
  }
  if (options.diff && !options.json) {
    throw new Error("sift batch --diff requires --json");
  }

  return {
    ...options,
    concurrency,
    oldLockfile: options.positionals[0],
    newLockfile: options.positionals[1]
  };
}

function parseConcurrency(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("--concurrency must be a positive integer");
  }
  return parsed;
}

if (isDirectRun()) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`sift: ${message}\n`);
    process.exitCode = 1;
  });
}

function isDirectRun(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return process.argv[1] === fileURLToPath(import.meta.url);
  }
}
