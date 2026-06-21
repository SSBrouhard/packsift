#!/usr/bin/env node
import { analyze } from "./analyze.js";
import { formatHuman } from "./format.js";
import { fetchArtifacts } from "./registry.js";
import { assertSamePackage, parsePackageSpec } from "./spec.js";

interface CliOptions {
  json: boolean;
  diff: boolean;
  registry: string;
  keep: boolean;
  positionals: string[];
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
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

function parseArgs(args: string[]): CliOptions {
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

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`sift: ${message}\n`);
  process.exitCode = 1;
});
