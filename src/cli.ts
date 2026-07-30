#!/usr/bin/env node
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyze } from "./analyze.js";
import { advisorySource, buildAdvisorySidecar, buildInspectAdvisorySidecar, fetchAdvisories, isPublicOsvEndpoint } from "./advisories.js";
import { analyzeBatch, classifyTransitions } from "./batch.js";
import { formatBatchHuman, formatHuman, formatInspectHuman } from "./format.js";
import { inspectPackage } from "./inspect.js";
import { parseLockfileContent } from "./lockfile.js";
import { fetchArtifacts, fetchPackage } from "./registry.js";
import { assertSamePackage, parsePackageSpec } from "./spec.js";
import { type AdvisorySidecar, type BatchReport, type InspectAdvisorySidecar, type InspectReport, type Report } from "./types.js";

const DEFAULT_REGISTRY = "https://registry.npmjs.org";
type AdvisoryMode = "off" | "structured" | "summary";

export interface CliOptions {
  json: boolean;
  diff: boolean;
  advisories: AdvisoryMode;
  advisoryEndpoint?: string;
  advisoriesAllowPublic: boolean;
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
  if (argv[0] === "inspect") {
    if (isHelpRequest(argv.slice(1))) {
      process.stdout.write(inspectHelpText());
      return;
    }
    await runInspect(parseArgs(argv.slice(1)));
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

interface InspectDeps {
  fetchPackage?: typeof fetchPackage;
  inspectPackage?: typeof inspectPackage;
  fetchAdvisories?: typeof fetchAdvisories;
  now?: () => Date;
  write?: (text: string) => void;
}

export async function runSingleTransition(options: CliOptions, deps: SingleTransitionDeps = {}): Promise<void> {
  if (options.positionals.length !== 2) {
    throw new Error("Expected exactly two positional args: packsift <name>@<old> <name>@<new>");
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
    const advisorySidecar = options.advisories !== "off"
      ? await buildAdvisorySidecar(
        oldSpec.name,
        oldSpec.version,
        newSpec.version,
        advisoryFetcher(options, deps.fetchAdvisories ?? fetchAdvisories),
        deps.now ?? (() => new Date()),
        advisorySource(options.advisoryEndpoint)
      )
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

export async function runInspect(options: CliOptions, deps: InspectDeps = {}): Promise<void> {
  if (options.positionals.length !== 1) {
    throw new Error("Expected exactly one positional arg: packsift inspect <name>@<version>");
  }
  assertAdvisoryRegistry(options);

  const spec = parsePackageSpec(options.positionals[0]);
  const fetchPackageImpl = deps.fetchPackage ?? fetchPackage;
  const inspectImpl = deps.inspectPackage ?? inspectPackage;
  const write = deps.write ?? ((text: string) => process.stdout.write(text));

  const fetched = await fetchPackageImpl(spec, { registry: options.registry, keep: options.keep });
  try {
    const report = await inspectImpl({
      packageName: spec.name,
      version: spec.version,
      packageDir: fetched.artifacts.extractDir,
      registryManifest: fetched.artifacts.registryManifest,
      metadata: fetched.metadata,
      integrityWarnings: fetched.integrityWarnings
    });
    const advisorySidecar = options.advisories !== "off"
      ? await buildInspectAdvisorySidecar(
        spec.name,
        spec.version,
        advisoryFetcher(options, deps.fetchAdvisories ?? fetchAdvisories),
        deps.now ?? (() => new Date()),
        advisorySource(options.advisoryEndpoint)
      )
      : undefined;

    if (options.json) {
      write(`${JSON.stringify(withInspectAdvisorySidecar(report, advisorySidecar), null, 2)}\n`);
    } else {
      write(formatInspectHuman(report, advisorySidecar));
    }
  } finally {
    await fetched.cleanup();
  }
}

interface BatchDeps {
  readStdin?: () => Promise<string>;
  runGitShow?: (ref: string, filePath: string) => Promise<string>;
  fetchArtifacts?: typeof fetchArtifacts;
  fetchPackage?: typeof fetchPackage;
  analyze?: typeof analyze;
  inspectPackage?: typeof inspectPackage;
  fetchAdvisories?: typeof fetchAdvisories;
  now?: () => Date;
  write?: (text: string) => void;
}

export async function runBatch(options: BatchCliOptions, deps: BatchDeps = {}): Promise<void> {
  assertAdvisoryRegistry(options);
  const stdinCount = [options.oldLockfile, options.newLockfile].filter((arg) => arg === "-").length;
  if (stdinCount > 1) throw new Error("packsift batch accepts stdin for only one lockfile argument");

  const oldSource = await resolveLockfileArgument(options.oldLockfile, deps);
  const newSource = await resolveLockfileArgument(options.newLockfile, deps);
  const oldParsed = parseLockfileContent(oldSource.content, oldSource.label, options.registry);
  const newParsed = parseLockfileContent(newSource.content, newSource.label, options.registry);
  const classified = classifyTransitions(oldParsed.map, newParsed.map);
  const batch = await analyzeBatch(classified, {
    registry: options.registry,
    keep: options.keep,
    includeDiffs: options.diff,
    concurrency: options.concurrency,
    advisories: options.advisories === "off"
      ? undefined
      : {
        fetchAdvisories: advisoryFetcher(options, deps.fetchAdvisories ?? fetchAdvisories),
        now: deps.now ?? (() => new Date()),
        source: advisorySource(options.advisoryEndpoint)
      }
  }, {
    fetchArtifacts: deps.fetchArtifacts,
    fetchPackage: deps.fetchPackage,
    analyze: deps.analyze,
    inspectPackage: deps.inspectPackage
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
    advisories: "off",
    advisoriesAllowPublic: false,
    registry: DEFAULT_REGISTRY,
    keep: false,
    positionals: []
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--diff") options.diff = true;
    else if (arg === "--advisories") options.advisories = "structured";
    else if (arg === "--advisories=summary") options.advisories = "summary";
    else if (arg.startsWith("--advisories=")) throw new Error("Only --advisories=summary is supported; use bare --advisories for structured fields");
    else if (arg === "--advisory-endpoint") {
      const value = args[index + 1];
      if (!value) throw new Error("--advisory-endpoint requires a URL");
      options.advisoryEndpoint = parseEndpointUrl(value, "--advisory-endpoint");
      index += 1;
    } else if (arg === "--advisories-allow-public") options.advisoriesAllowPublic = true;
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
    advisories: "off",
    advisoriesAllowPublic: false,
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
      options.advisories = "structured";
    } else if (arg === "--advisories=summary") {
      options.advisories = "summary";
    } else if (arg.startsWith("--advisories=")) {
      throw new Error("Only --advisories=summary is supported; use bare --advisories for structured fields");
    } else if (arg === "--advisory-endpoint") {
      const value = args[index + 1];
      if (!value) throw new Error("--advisory-endpoint requires a URL");
      options.advisoryEndpoint = parseEndpointUrl(value, "--advisory-endpoint");
      index += 1;
    } else if (arg === "--advisories-allow-public") {
      options.advisoriesAllowPublic = true;
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
    throw new Error("Expected exactly two lockfile inputs: packsift batch <old-lockfile> <new-lockfile>");
  }
  if (options.positionals.filter((arg) => arg === "-").length > 1) {
    throw new Error("packsift batch accepts stdin for only one lockfile argument");
  }
  if (options.diff && !options.json && !detail) {
    throw new Error("packsift batch --diff requires --json unless --detail is set");
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
  packsift <name>@<old> <name>@<new> [options]
  packsift inspect <name>@<version> [options]
  packsift batch <old-lockfile> <new-lockfile> [options]

Options:
  --json              Emit structured JSON
  --diff              Include full text diffs for changed transition files
  --advisories        Add the opt-in OSV.dev advisory sidecar
  --advisories=summary
                      Include OSV summary text as third-party passthrough
  --advisory-endpoint <url>
                      Query an OSV-compatible advisory endpoint
  --advisories-allow-public
                      Allow public OSV lookup with a custom registry
  --registry <url>    npm registry URL, defaulting to ${DEFAULT_REGISTRY}
  --keep              Preserve extracted tarballs and temp dirs
  --help, -h          Show this help

Batch options:
  --detail            Expand analyzed entries in human output
  --concurrency <n>   Batch fetch/analyze parallelism, defaulting to 4
`;
}

export function inspectHelpText(): string {
  return `Usage:
  packsift inspect <name>@<version> [options]

Options:
  --json              Emit structured JSON
  --advisories        Add the opt-in OSV.dev advisory sidecar
  --advisories=summary
                      Include OSV summary text as third-party passthrough
  --advisory-endpoint <url>
                      Query an OSV-compatible advisory endpoint
  --advisories-allow-public
                      Allow public OSV lookup with a custom registry
  --registry <url>    npm registry URL, defaulting to ${DEFAULT_REGISTRY}
  --keep              Preserve extracted tarballs and temp dirs
  --help, -h          Show this help

`;
}

export function batchHelpText(): string {
  return `Usage:
  packsift batch <old-lockfile> <new-lockfile> [options]

Options:
  --json              Emit structured JSON
  --diff              Include full text diffs for changed transitions; requires --json unless --detail is set
  --detail            Expand analyzed entries in human output
  --advisories        Add per-package OSV.dev advisory sidecars
  --advisories=summary
                      Include OSV summary text as third-party passthrough
  --advisory-endpoint <url>
                      Query an OSV-compatible advisory endpoint
  --advisories-allow-public
                      Allow public OSV lookup with a custom registry
  --registry <url>    npm registry URL, defaulting to ${DEFAULT_REGISTRY}
  --keep              Preserve extracted tarballs and temp dirs
  --concurrency <n>   Batch fetch/analyze parallelism, defaulting to 4
  --help, -h          Show this help

`;
}

function withAdvisorySidecar(report: Report, advisorySidecar?: AdvisorySidecar): Report | (Report & { advisorySidecar: AdvisorySidecar }) {
  return advisorySidecar ? { ...report, advisorySidecar } : report;
}

function withInspectAdvisorySidecar(report: InspectReport, advisorySidecar?: InspectAdvisorySidecar): InspectReport | (InspectReport & { advisorySidecar: InspectAdvisorySidecar }) {
  return advisorySidecar ? { ...report, advisorySidecar } : report;
}

function assertAdvisoryRegistry(options: Pick<CliOptions, "advisories" | "registry" | "advisoryEndpoint" | "advisoriesAllowPublic">): void {
  if (
    options.advisories !== "off"
    && options.registry !== DEFAULT_REGISTRY
    && !options.advisoriesAllowPublic
    && (!options.advisoryEndpoint || isPublicOsvEndpoint(options.advisoryEndpoint))
  ) {
    throw new Error(
      `--advisories with a custom registry requires --advisory-endpoint <url> or --advisories-allow-public to avoid sending custom registry package coordinates to OSV.dev`
    );
  }
}

function advisoryFetcher(options: Pick<CliOptions, "advisories" | "advisoryEndpoint">, fetchAdvisoriesImpl: typeof fetchAdvisories): typeof fetchAdvisories {
  return (name, version) => fetchAdvisoriesImpl(name, version, {
    endpoint: options.advisoryEndpoint,
    includeSummary: options.advisories === "summary"
  });
}

function parseEndpointUrl(value: string, flag: string): string {
  try {
    return new URL(value).toString();
  } catch {
    throw new Error(`${flag} requires a valid URL`);
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
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["show", `${ref}:${filePath}`], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `git show exited with code ${code ?? "unknown"}`));
    });
  });
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
    process.stderr.write(`packsift: ${message}\n`);
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
