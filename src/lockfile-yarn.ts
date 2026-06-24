import { parse as parseYaml } from "yaml";
import { addVersion, decodedPathSegments, isRecord, isRegistryTarballUrl, parseRegistryUrl } from "./lockfile.js";
import { ParsedLockfile, VersionSetMap } from "./types.js";

interface YarnClassicEntry {
  version?: string;
  resolved?: string;
}

interface RegistryCandidate {
  url: URL;
  baseSegments: string[];
}

const DEFAULT_NPM_REGISTRY_HOST = "registry.npmjs.org";
const YARN_CLASSIC_REGISTRY_MIRROR = "https://registry.yarnpkg.com";

export function parseYarnLockfileData(raw: string, label: string, registry: string): ParsedLockfile {
  if (isYarnClassic(raw)) {
    return {
      map: parseYarnClassic(raw, label, registry),
      format: "yarn",
      formatLabel: "yarn.lock v1"
    };
  }
  const berry = parseYarnBerry(raw, label);
  return {
    map: berry.map,
    format: "yarn",
    formatLabel: berry.formatLabel
  };
}

function isYarnClassic(raw: string): boolean {
  return raw.split(/\r?\n/).some((line) => line.trim() === "# yarn lockfile v1");
}

function parseYarnClassic(raw: string, label: string, registry: string): VersionSetMap {
  const registryCandidates = yarnClassicRegistryCandidates(registry);

  const entries = new Map<string, YarnClassicEntry>();
  let currentKeys: string[] = [];

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("#")) continue;
    if (!line.startsWith(" ") && line.endsWith(":")) {
      currentKeys = splitYarnClassicKeys(line.slice(0, -1));
      for (const key of currentKeys) entries.set(key, {});
      continue;
    }
    const match = /^ {2}([A-Za-z][\w-]*) "?([^"]*)"?$/.exec(line);
    if (!match || currentKeys.length === 0) continue;
    const [, field, value] = match;
    if (field !== "version" && field !== "resolved") continue;
    for (const key of currentKeys) {
      const entry = entries.get(key);
      if (entry) entry[field] = value;
    }
  }

  const versions: VersionSetMap = new Map();
  for (const [descriptor, entry] of entries) {
    const name = packageNameFromYarnDescriptor(descriptor);
    if (!name || descriptor.includes("npm:") || typeof entry.version !== "string" || typeof entry.resolved !== "string") continue;
    if (!isYarnClassicRegistryTarballUrl(stripYarnResolvedHash(entry.resolved), name, entry.version, registryCandidates)) continue;
    addVersion(versions, name, entry.version);
  }
  if (versions.size === 0 && entries.size === 0) throw new Error(`${label} is unsupported: could not parse yarn.lock v1 entries`);
  return versions;
}

function yarnClassicRegistryCandidates(registry: string): RegistryCandidate[] {
  const registryUrl = parseRegistryUrl(registry);
  const registryBaseSegments = decodedPathSegments(registryUrl.pathname);
  if (!registryBaseSegments) throw new Error(`Invalid registry URL: ${registry}`);

  const candidates: RegistryCandidate[] = [{ url: registryUrl, baseSegments: registryBaseSegments }];
  if (isDefaultNpmRegistry(registryUrl, registryBaseSegments)) {
    candidates.push({ url: new URL(YARN_CLASSIC_REGISTRY_MIRROR), baseSegments: [] });
  }
  return candidates;
}

function isDefaultNpmRegistry(registryUrl: URL, registryBaseSegments: string[]): boolean {
  return registryUrl.protocol === "https:" && registryUrl.host === DEFAULT_NPM_REGISTRY_HOST && registryBaseSegments.length === 0;
}

function isYarnClassicRegistryTarballUrl(resolved: string, name: string, version: string, candidates: RegistryCandidate[]): boolean {
  return candidates.some((candidate) => isRegistryTarballUrl(resolved, name, version, candidate.url, candidate.baseSegments));
}

function parseYarnBerry(raw: string, label: string): { map: VersionSetMap; formatLabel: string } {
  const parsed = parseYarnBerryDocument(raw, label);
  const metadataVersion = parsed.__metadata.version;
  const versionLabel = typeof metadataVersion === "string" || typeof metadataVersion === "number" ? ` v${metadataVersion}` : "";

  const versions: VersionSetMap = new Map();
  for (const [descriptor, entry] of Object.entries(parsed)) {
    if (descriptor === "__metadata" || !isRecord(entry)) continue;
    const version = entry.version;
    const resolution = entry.resolution;
    if (typeof version !== "string" || typeof resolution !== "string") continue;
    const name = packageNameFromBerryLocator(resolution);
    const descriptorName = packageNameFromBerryDescriptor(descriptor);
    if (!name || !descriptorName || name !== descriptorName) continue;
    if (!resolution.includes("@npm:") || isNonRegistryYarnReference(resolution) || isNonRegistryYarnReference(descriptor)) continue;
    addVersion(versions, name, version);
  }

  return { map: versions, formatLabel: `yarn.lock Berry${versionLabel}` };
}

function parseYarnBerryDocument(raw: string, label: string): Record<string, unknown> & { __metadata: Record<string, unknown> } {
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (error) {
    throw new Error(`${label} is not valid yarn Berry YAML: ${messageFor(error)}`);
  }
  if (!isRecord(parsed) || !isRecord(parsed.__metadata)) {
    throw new Error(`${label} is unsupported: expected yarn.lock v1 or Berry lockfile`);
  }
  return parsed as Record<string, unknown> & { __metadata: Record<string, unknown> };
}

function splitYarnClassicKeys(value: string): string[] {
  const unquoted = stripOuterQuotes(value.trim());
  return unquoted.split(/,\s*/).map((key) => stripOuterQuotes(key.trim())).filter(Boolean);
}

function packageNameFromYarnDescriptor(descriptor: string): string | undefined {
  const clean = stripOuterQuotes(descriptor.trim());
  const atIndex = clean.startsWith("@") ? clean.indexOf("@", 1) : clean.indexOf("@");
  if (atIndex <= 0) return undefined;
  return clean.slice(0, atIndex);
}

function packageNameFromBerryDescriptor(descriptor: string): string | undefined {
  const clean = stripOuterQuotes(descriptor.trim());
  const marker = clean.indexOf("@npm:");
  if (marker <= 0) return undefined;
  return clean.slice(0, marker);
}

function packageNameFromBerryLocator(locator: string): string | undefined {
  const marker = locator.indexOf("@npm:");
  if (marker <= 0) return undefined;
  return locator.slice(0, marker);
}

function isNonRegistryYarnReference(value: string): boolean {
  return /(?:^|:)workspace:|(?:^|:)patch:|(?:^|:)portal:|(?:^|:)link:|(?:^|:)file:|(?:^|:)git[+:]/.test(value);
}

function stripOuterQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  return value;
}

function stripYarnResolvedHash(value: string): string {
  return value.split("#")[0];
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
