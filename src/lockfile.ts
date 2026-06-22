import { readFile } from "node:fs/promises";
import { VersionSetMap } from "./types.js";

interface NpmLockfile {
  lockfileVersion?: number;
  packages?: unknown;
}

interface LockfilePackageEntry {
  version?: unknown;
}

export async function parseLockfile(filePath: string): Promise<VersionSetMap> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(`Could not read lockfile ${filePath}: ${messageFor(error)}`);
  }

  let parsed: NpmLockfile;
  try {
    parsed = JSON.parse(raw) as NpmLockfile;
  } catch (error) {
    throw new Error(`Could not parse lockfile ${filePath}: ${messageFor(error)}`);
  }

  return parseLockfileData(parsed, filePath);
}

export function parseLockfileData(lockfile: NpmLockfile, label = "lockfile"): VersionSetMap {
  if ((lockfile.lockfileVersion !== 2 && lockfile.lockfileVersion !== 3) || !isRecord(lockfile.packages)) {
    throw new Error(`${label} is unsupported: expected npm package-lock v2/v3 with a packages map`);
  }

  const versions: VersionSetMap = new Map();
  for (const [lockPath, entry] of Object.entries(lockfile.packages)) {
    if (lockPath === "") continue;
    const name = packageNameFromLockPath(lockPath);
    if (!name || !isRecord(entry)) continue;
    const version = (entry as LockfilePackageEntry).version;
    if (typeof version !== "string") continue;
    addVersion(versions, name, version);
  }

  return versions;
}

export function packageNameFromLockPath(lockPath: string): string | undefined {
  const marker = "node_modules/";
  const index = lockPath.lastIndexOf(marker);
  if (index === -1) return undefined;
  return lockPath.slice(index + marker.length);
}

function addVersion(versions: VersionSetMap, name: string, version: string): void {
  const set = versions.get(name) ?? new Set<string>();
  set.add(version);
  versions.set(name, set);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
