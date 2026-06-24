#!/usr/bin/env node
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { analyze } from "./analyze.js";
import { fetchAdvisories } from "./advisories.js";
import { analyzeBatch, classifyTransitions } from "./batch.js";
import { formatBatchHuman, formatHuman } from "./format.js";
import { parseLockfileContent } from "./lockfile.js";
import { fetchArtifacts } from "./registry.js";
import { assertSamePackage, parsePackageSpec } from "./spec.js";
import { type Advisory, type AdvisorySidecar, type BatchReport, type Report } from "./types.js";

const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const execFileAsync = promisify(execFile);

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
  detail: boolean;
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

interface BatchDeps {
  readStdin?: () => Promise<string>;
  runGitShow?: (ref: string, filePath: string) => Promise<string>;
  write?: (text: string) => void;
}

export async function runBatch(options: BatchCliOptions, deps: BatchDeps = {}): Promise<void> {
  const stdinCount = [options.oldLockfile, options.newLockfile].filter((arg) => arg === "-").length;
  if (stdinCount > 1) throw new Error("sift batch accepts stdin for only one lockfile argument");

  const oldSource = await resolveLockfileArgument(options.oldLockfile, deps);
  const newSource = await resolveLockfileArgument(options.newLockfile, deps);
  const oldParsed = parseLockfileContent(oldSource.content, oldSource.label, options.registry);
  const newParsed = parseLockfileContent(newSource.content, newSource.label, options.registry);
  const classified = classifyTransitions(oldParsed.map, newParsed.map);
  const batch = await analyzeBatch(classified, {
    registry: options.registry,
    keep: options.keep,
    includeDiffs: options.diff,
    concurrency: options.concurrency
  });
  const report: BatchReport = {
    sources: {
      old: oldParsed.formatLabel,
      new: newParsed.formatLabel
    },
    ...batch
  };

  const write = deps.write ?? ((text: string) => process.stdout.write(text));
  if (options.json) {
    write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    write(formatBatchHuman(report, { detail: options.detail, includeDiffs: options.diff }));
  }
  applyBatchExitCode(report);
}

export interface ResolvedLockfileInput {
  content: string;
  label: string;
}

export async function resolveLockfileArgument(arg: string, deps: Pick<BatchDeps, "readStdin" | "runGitShow"> = {}): Promise<ResolvedLockfileInput> {
  if (arg === "-") {
    const readStdin = deps.readStdin ?? readProcessStdin;
    return { content: await readStdin(), label: "stdin" };
  }
  const refInput = splitGitRefInput(arg);
  if (refInput) {
    const runGitShow = deps.runGitShow ?? defaultGitShow;
    try {
      return { content: await runGitShow(refInput.ref, refInput.filePath), label: path.basename(refInput.filePath) };
    } catch (error) {
      throw new Error(`Could not read lockfile ${arg}: ${errorMessage(error)}`);
    }
  }
  try {
    return { content: await readFile(arg, "utf8"), label: arg };
  } catch (error) {
    throw new Error(`Could not read lockfile ${arg}: ${errorMessage(error)}`);
  }
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
  let detail = false;

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
    } else if (arg === "--detail") {
      detail = true;
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
    throw new Error("Expected exactly two lockfile inputs: sift batch <old-lockfile> <new-lockfile>");
  }
  if (options.positionals.filter((arg) => arg === "-").length > 1) {
    throw new Error("sift batch accepts stdin for only one lockfile argument");
  }
  if (options.diff && !options.json && !detail) {
    throw new Error("sift batch --diff requires --json unless --detail is set");
  }

  return {
    ...options,
    concurrency,
    detail,
    oldLockfile: options.positionals[0],
    newLockfile: options.positionals[1]
  };
}

export function helpText(): string {
  return `Usage:
  sift <name>@<old> <name>@<new> [options]
  sift batch <old-lockfile> <new-lockfile> [options]

Options:
  --json              Emit structured JSON
  --diff              Include full text diffs for changed text files
  --advisories        Add the opt-in OSV.dev advisory sidecar
  --registry <url>    npm registry URL, defaulting to ${DEFAULT_REGISTRY}
  --keep              Preserve extracted tarballs and temp dirs
  --help, -h          Show this help

Batch options:
  --detail            Expand analyzed entries in human output
  --concurrency <n>   Batch fetch/analyze parallelism, defaulting to 4
`;
}

export function batchHelpText(): string {
  return `Usage:
  sift batch <old-lockfile> <new-lockfile> [options]

Options:
  --json              Emit structured JSON
  --diff              Include full text diffs; requires --json unless --detail is set
  --detail            Expand analyzed entries in human output
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

function splitGitRefInput(arg: string): { ref: string; filePath: string } | undefined {
  const index = arg.indexOf(":");
  if (index <= 0 || index === arg.length - 1) return undefined;
  const ref = arg.slice(0, index);
  const filePath = arg.slice(index + 1);
  if (filePath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(arg)) return undefined;
  return { ref, filePath };
}

async function defaultGitShow(ref: string, filePath: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["show", `${ref}:${filePath}`], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  return stdout;
}

async function readProcessStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
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
