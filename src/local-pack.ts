import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extractPackageTarball } from "./registry.js";
import { PackageManifest } from "./types.js";

export interface LocalPackResult {
  manifest: PackageManifest & { name: string; version: string };
  tarballPath: string;
  extractDir: string;
  cleanup: () => Promise<void>;
}

export interface LocalPackOptions {
  keep: boolean;
}

interface NpmPackResult {
  filename?: string;
}

export async function prepareLocalPackage(input: string, options: LocalPackOptions): Promise<LocalPackResult> {
  const resolvedInput = path.resolve(input);
  const inputStats = await stat(resolvedInput).catch(() => undefined);
  if (!inputStats) throw new Error(`Local package input does not exist: ${input}`);

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "packsift-pack-check-"));
  try {
    const tarballPath = inputStats.isDirectory()
      ? await npmPack(resolvedInput, tempRoot)
      : await resolveTarballInput(resolvedInput);
    const extractDir = path.join(tempRoot, "local");
    await extractPackageTarball(tarballPath, extractDir);
    const manifest = await readPackedManifest(extractDir);

    return {
      manifest,
      tarballPath,
      extractDir,
      cleanup: async () => {
        if (!options.keep) await rm(tempRoot, { recursive: true, force: true });
      }
    };
  } catch (error) {
    if (!options.keep) await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

async function resolveTarballInput(input: string): Promise<string> {
  if (path.extname(input).toLowerCase() !== ".tgz") {
    throw new Error(`Local package input must be a directory or .tgz file: ${input}`);
  }
  return input;
}

async function readPackedManifest(extractDir: string): Promise<PackageManifest & { name: string; version: string }> {
  let value: PackageManifest;
  try {
    value = JSON.parse(await readFile(path.join(extractDir, "package.json"), "utf8")) as PackageManifest;
  } catch (error) {
    throw new Error(`Local package tarball has no readable package.json: ${errorMessage(error)}`);
  }
  if (typeof value.name !== "string" || value.name.length === 0) {
    throw new Error("Local packed package.json must contain a package name");
  }
  if (typeof value.version !== "string" || value.version.length === 0) {
    throw new Error("Local packed package.json must contain a package version");
  }
  return value as PackageManifest & { name: string; version: string };
}

async function npmPack(packageDir: string, destination: string): Promise<string> {
  const npmCli = process.env.npm_execpath;
  const command = npmCli ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
  const args = npmCli
    ? [npmCli, "pack", "--json", "--pack-destination", destination]
    : ["pack", "--json", "--pack-destination", destination];
  const result = await run(command, args, packageDir);
  let packed: NpmPackResult[];
  try {
    packed = JSON.parse(result.stdout) as NpmPackResult[];
  } catch {
    throw new Error(`npm pack did not return valid JSON${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
  }
  const filename = packed[0]?.filename;
  if (!filename) throw new Error("npm pack did not report a tarball filename");
  return path.join(destination, path.basename(filename));
}

async function run(command: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
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
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`npm pack failed with exit code ${code ?? "unknown"}${stderr ? `: ${stderr.trim()}` : ""}`));
    });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
