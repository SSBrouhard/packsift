import { parse as parseYaml } from "yaml";
import { addVersion, decodedPathSegments, isRecord, isRegistryTarballUrl, parseRegistryUrl } from "./lockfile.js";
import { ParsedLockfile, VersionSetMap } from "./types.js";

const SUPPORTED_LOCKFILE_VERSIONS = new Set(["5.4", "6.0", "9.0"]);

interface PnpmPackageKey {
  name: string;
  version: string;
}

export function parsePnpmLockfileData(raw: string, label: string, registry: string): ParsedLockfile {
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (error) {
    throw new Error(`${label} is not valid pnpm-lock.yaml: ${messageFor(error)}`);
  }
  if (!isRecord(parsed)) throw new Error(`${label} is unsupported: expected pnpm-lock.yaml`);

  const lockfileVersion = normalizedLockfileVersion(parsed.lockfileVersion);
  if (!SUPPORTED_LOCKFILE_VERSIONS.has(lockfileVersion)) {
    throw new Error(`${label} is unsupported: expected pnpm-lock.yaml v5.4, v6.0, or v9.0`);
  }
  if (!isRecord(parsed.packages)) throw new Error(`${label} is unsupported: expected pnpm-lock.yaml with a packages map`);
  const aliasOnlyKeys = collectAliasOnlyPackageKeys(parsed);

  const registryUrl = parseRegistryUrl(registry);
  const registryBaseSegments = decodedPathSegments(registryUrl.pathname);
  if (!registryBaseSegments) throw new Error(`Invalid registry URL: ${registry}`);

  const versions: VersionSetMap = new Map();
  for (const [rawKey, entry] of Object.entries(parsed.packages)) {
    const key = parsePnpmPackageKey(rawKey);
    if (!key || !isRecord(entry)) continue;
    if (aliasOnlyKeys.has(`${key.name}@${key.version}`)) continue;
    if (!isRegistryPnpmEntry(entry, key, registryUrl, registryBaseSegments)) continue;
    addVersion(versions, key.name, key.version);
  }

  return {
    map: versions,
    format: "pnpm",
    formatLabel: `pnpm-lock.yaml v${lockfileVersion}`
  };
}

function collectAliasOnlyPackageKeys(lockfile: Record<string, unknown>): Set<string> {
  const aliasTargets = new Set<string>();
  const directTargets = new Set<string>();
  if (!isRecord(lockfile.importers)) return aliasTargets;

  for (const importer of Object.values(lockfile.importers)) {
    if (!isRecord(importer)) continue;
    collectDependencyReferences(importer, aliasTargets, directTargets);
  }

  if (isRecord(lockfile.packages)) {
    for (const entry of Object.values(lockfile.packages)) {
      if (isRecord(entry)) collectDependencyReferences(entry, aliasTargets, directTargets);
    }
  }

  if (isRecord(lockfile.snapshots)) {
    for (const entry of Object.values(lockfile.snapshots)) {
      if (isRecord(entry)) collectDependencyReferences(entry, aliasTargets, directTargets);
    }
  }

  return new Set([...aliasTargets].filter((key) => !directTargets.has(key)));
}

function collectDependencyReferences(entry: Record<string, unknown>, aliasTargets: Set<string>, directTargets: Set<string>): void {
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
    const dependencies = entry[field];
    if (!isRecord(dependencies)) continue;
    for (const [declaredName, dependency] of Object.entries(dependencies)) {
      const target = pnpmDependencyTarget(declaredName, dependency);
      if (!target) continue;
      const key = `${target.name}@${target.version}`;
      if (declaredName === target.name) directTargets.add(key);
      else aliasTargets.add(key);
    }
  }
}

function pnpmDependencyTarget(declaredName: string, value: unknown): PnpmPackageKey | undefined {
  if (typeof value === "string") return exactVersionTarget(declaredName, value) ?? parsePnpmDependencyVersion(value);
  if (!isRecord(value)) return undefined;
  const specifier = typeof value.specifier === "string" ? value.specifier : undefined;
  const version = typeof value.version === "string" ? value.version : undefined;
  return exactVersionTarget(declaredName, version) ?? parsePnpmDependencyVersion(version) ?? parsePnpmAliasSpecifier(specifier);
}

function parsePnpmDependencyVersion(value: string | undefined): PnpmPackageKey | undefined {
  if (!value) return undefined;
  return parsePnpmPackageKey(value);
}

function parsePnpmAliasSpecifier(value: string | undefined): PnpmPackageKey | undefined {
  if (!value?.startsWith("npm:")) return undefined;
  return parsePnpmPackageKey(value.slice("npm:".length));
}

function exactVersionTarget(name: string, version: string | undefined): PnpmPackageKey | undefined {
  const baseVersion = version ? basePnpmVersion(version) : undefined;
  if (!baseVersion || isNonRegistrySpecifier(version ?? "") || baseVersion.includes(":") || baseVersion.includes("/") || baseVersion.includes("@")) return undefined;
  return { name, version: baseVersion };
}

function normalizedLockfileVersion(value: unknown): string {
  if (typeof value === "number") return value.toFixed(1);
  if (typeof value === "string") {
    const match = /^(\d+)(?:\.(\d+))?/.exec(value);
    if (match) return `${match[1]}.${match[2] ?? "0"}`;
  }
  return "";
}

function parsePnpmPackageKey(rawKey: string): PnpmPackageKey | undefined {
  let key = rawKey.trim();
  if (!key) return undefined;
  if (key.startsWith("/")) key = key.slice(1);
  key = key.replace(/\(.+\)$/, "");
  return parsePnpmAtDelimitedKey(key) ?? parsePnpmSlashDelimitedKey(key);
}

function parsePnpmAtDelimitedKey(key: string): PnpmPackageKey | undefined {
  const atIndex = key.startsWith("@") ? key.indexOf("@", 1) : key.indexOf("@");
  if (atIndex <= 0) return undefined;
  const name = key.slice(0, atIndex);
  const version = basePnpmVersion(key.slice(atIndex + 1));
  if (!isPnpmPackageName(name) || !version || isNonRegistrySpecifier(version)) return undefined;
  return { name, version };
}

function parsePnpmSlashDelimitedKey(key: string): PnpmPackageKey | undefined {
  const slashIndex = key.lastIndexOf("/");
  if (slashIndex <= 0) return undefined;
  const name = key.slice(0, slashIndex);
  const version = basePnpmVersion(key.slice(slashIndex + 1));
  if (!isPnpmPackageName(name) || !version || isNonRegistrySpecifier(version)) return undefined;
  return { name, version };
}

function basePnpmVersion(version: string): string {
  return version.replace(/\(.+\)$/, "").split("_", 1)[0];
}

function isPnpmPackageName(name: string): boolean {
  if (!name) return false;
  if (!name.startsWith("@")) return !name.includes("/");
  const parts = name.split("/");
  return parts.length === 2 && parts[0].length > 1 && parts[1].length > 0;
}

function isRegistryPnpmEntry(entry: Record<string, unknown>, key: PnpmPackageKey, registryUrl: URL, registryBaseSegments: string[]): boolean {
  const resolution = entry.resolution;
  if (!isRecord(resolution)) return false;
  const tarball = resolution.tarball;
  if (typeof tarball === "string") {
    if (isNonRegistrySpecifier(tarball)) return false;
    if (tarball.startsWith("http://") || tarball.startsWith("https://")) {
      return isRegistryTarballUrl(tarball, key.name, key.version, registryUrl, registryBaseSegments);
    }
  }
  return typeof resolution.integrity === "string";
}

function isNonRegistrySpecifier(value: string): boolean {
  return /^(?:link|file|workspace|git|github|git\+ssh|git\+https):/.test(value);
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
