#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { analyze } from "./analyze.js";
import { fetchAdvisories } from "./advisories.js";
import { analyzeBatch, classifyTransitions } from "./batch.js";
import { formatBatchHuman, formatHuman } from "./format.js";
import { parseLockfile } from "./lockfile.js";
import { fetchArtifacts } from "./registry.js";
import { assertSamePackage, parsePackageSpec } from "./spec.js";
import { type Advisory, type AdvisorySidecar, type BatchReport, type Report } from "./types.js";

const DEFAULT_REGISTRY = "https://registry.npmjs.org";

export interface CliOptions {
  json: boolean;
  diff: boolean;
  advisories: boolean;
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
  if (isHelpRequest(argv)) {
    process.stdout.write(helpText());
    return;
  }
  if (argv[0] === "batch") {
    if (isHelpRequest(argv.slice(1))) {
      process.stdout.write(batchHelpText());
      return;
    }
    await runBatch(parseBatchArgs(argv.slice(1)));
    return;
  }

  const options = parseArgs(argv);
  await runSingleTransition(options);
}

interface SingleTransitionDeps {
  fetchArtifacts?: typeof fetchArtifacts;
  analyze?: typeof analyze;
  fetchAdvisories?: typeof fetchAdvisories;
  now?: () => Date;
  write?: (text: string) => void;
}

export async function runSingleTransition(options: CliOptions, deps: SingleTransitionDeps = {}): Promise<void> {
  if (options.positionals.length !== 2) {
    throw new Error("Expected exactly two positional args: sift <name>@<old> <name>@<new>");
  }
  assertAdvisoryRegistry(options);

  const oldSpec = parsePackageSpec(options.positionals[0]);
  const newSpec = parsePackageSpec(options.positionals[1]);
  assertSamePackage(oldSpec, newSpec);

  const fetchArtifactsImpl = deps.fetchArtifacts ?? fetchArtifacts;
  const analyzeImpl = deps.analyze ?? analyze;
  const write = deps.write ?? ((text: string) => process.stdout.write(text));

  const fetched = await fetchArtifactsImpl(oldSpec, newSpec, { registry: options.registry, keep: options.keep });
  try {
    const report = await analyzeImpl(
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
    const advisorySidecar = options.advisories
      ? await buildAdvisorySidecar(oldSpec.name, oldSpec.version, newSpec.version, deps.fetchAdvisories ?? fetchAdvisories, deps.now ?? (() => new Date()))
      : undefined;

    if (options.json) {
      write(`${JSON.stringify(withAdvisorySidecar(report, advisorySidecar), null, 2)}\n`);
    } else {
      write(formatHuman(report, options.diff, advisorySidecar));
    }
  } finally {
    await fetched.cleanup();
  }
}

async function runBatch(options: BatchCliOptions): Promise<void> {
  const oldVersions = await parseLockfile(options.oldLockfile, options.registry);
  const newVersions = await parseLockfile(options.newLockfile, options.registry);
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
    advisories: false,
    registry: DEFAULT_REGISTRY,
    keep: false,
    positionals: []
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--diff") options.diff = true;
    else if (arg === "--advisories") options.advisories = true;
    else if (arg.startsWith("--advisories=")) throw new Error("--advisories values are not supported in v0; use bare --advisories");
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
    advisories: false,
    registry: DEFAULT_REGISTRY,
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
    } else if (arg === "--advisories") {
      throw new Error("sift batch --advisories is not supported in v0");
    } else if (arg.startsWith("--advisories=")) {
      throw new Error("--advisories values are not supported in v0; batch advisories are not supported");
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

export function helpText(): string {
  return `Usage:
  sift <name>@<old> <name>@<new> [options]
  sift batch <old-package-lock.json> <new-package-lock.json> [options]

Options:
  --json              Emit structured JSON
  --diff              Include full text diffs for changed text files
  --advisories        Add the opt-in OSV.dev advisory sidecar
  --registry <url>    npm registry URL, defaulting to ${DEFAULT_REGISTRY}
  --keep              Preserve extracted tarballs and temp dirs
  --help, -h          Show this help

Batch options:
  --concurrency <n>   Batch fetch/analyze parallelism, defaulting to 4
`;
}

export function batchHelpText(): string {
  return `Usage:
  sift batch <old-package-lock.json> <new-package-lock.json> [options]

Options:
  --json              Emit structured JSON
  --diff              Include full text diffs; requires --json
  --registry <url>    npm registry URL, defaulting to ${DEFAULT_REGISTRY}
  --keep              Preserve extracted tarballs and temp dirs
  --concurrency <n>   Batch fetch/analyze parallelism, defaulting to 4
  --help, -h          Show this help

Unsupported in batch mode:
  --advisories
`;
}

async function buildAdvisorySidecar(
  name: string,
  oldVersion: string,
  newVersion: string,
  fetchAdvisoriesImpl: (name: string, version: string) => Promise<Advisory[]>,
  now: () => Date
): Promise<AdvisorySidecar> {
  const [oldResult, newResult] = await Promise.allSettled([fetchAdvisoriesImpl(name, oldVersion), fetchAdvisoriesImpl(name, newVersion)]);
  return {
    enabled: true,
    source: "OSV.dev",
    fetchedAt: now().toISOString(),
    oldVersion: settleAdvisoryVersion(oldVersion, oldResult),
    newVersion: settleAdvisoryVersion(newVersion, newResult)
  };
}

function settleAdvisoryVersion(version: string, result: PromiseSettledResult<Advisory[]>) {
  if (result.status === "fulfilled") return { version, vulns: result.value };
  return { version, vulns: [], unavailable: errorMessage(result.reason) };
}

function withAdvisorySidecar(report: Report, advisorySidecar?: AdvisorySidecar): Report | (Report & { advisorySidecar: AdvisorySidecar }) {
  return advisorySidecar ? { ...report, advisorySidecar } : report;
}

function assertAdvisoryRegistry(options: Pick<CliOptions, "advisories" | "registry">): void {
  if (options.advisories && options.registry !== DEFAULT_REGISTRY) {
    throw new Error(`--advisories requires --registry ${DEFAULT_REGISTRY} to avoid sending custom registry package coordinates to OSV.dev`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseConcurrency(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("--concurrency must be a positive integer");
  }
  return parsed;
}

function isHelpRequest(args: string[]): boolean {
  return args.length === 1 && (args[0] === "--help" || args[0] === "-h");
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
